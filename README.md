# Vercel Blob Local

A Docker service that mimics the Vercel Blob API locally. It lets you run
development environments and integration tests using the official
`@vercel/blob` SDK without hitting Vercel servers or triggering usage costs.

Do not install this as an npm package in your application. Instead, run it as a
standalone Docker service and point the official SDK to it using environment
variables.

Blobs are stored on disk under `/data` inside the container, which the provided
Compose file persists using a named volume. If running outside Docker, it
defaults to `.vercel-blob-local` in your current working directory,
configurable via `VERCEL_BLOB_LOCAL_DIR`.

Blobs in volumes created by earlier releases remain readable unless their
pathnames conflict with the reserved names below. Compatible legacy blobs are
moved to the generation-addressed storage format automatically when
overwritten. The internal top-level namespaces `.data`, `.metadata`,
`.multipart`, and `.cleanup`, plus the single-segment service pathname
`health`, are reserved case-insensitively. Unsupported legacy entries are
skipped by `list()` and cannot be managed through the API; back up or relocate
them before upgrading.

Use one service instance per storage directory. Startup reconciliation removes
interrupted writes and obsolete generations, so sharing the same directory
between concurrently running instances is not supported.

Blob upload requests are limited to 100 MiB by default. Set
`VERCEL_BLOB_LOCAL_MAX_BODY_SIZE` to a maximum number of bytes to override the
limit.

## Docker Setup

Start the service:

```bash
pnpm install
pnpm run docker:up
```

Point the official SDK to your local instance by updating your app's
environment variables:

```env
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_local_test"
VERCEL_BLOB_API_URL="http://localhost:4545"
```

The Compose file exposes the API on `http://localhost:4545` and binds it to
`127.0.0.1` by default.

Published images:

- `ghcr.io/lafittemehdy/vercel-blob-local`
- `lafittemehdy/vercel-blob-local`

### Authentication

API commands and private blob URLs require an
`Authorization: Bearer <BLOB_READ_WRITE_TOKEN>` header. Public blobs can be
read freely without it.

The emulator supports static read-write tokens only. Vercel OIDC credentials,
`issueSignedToken()`, and `presignUrl()`/presigned URLs are not emulated. Unset
`VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` when using the local service because
the SDK prioritizes those credentials; either set `BLOB_READ_WRITE_TOKEN` as
shown above or pass the local `token` explicitly to SDK operations.

## SDK Compatibility

The goal is a seamless local setup using standard environment variables: no
monkey-patching the SDK, modifying local DNS, or managing self-signed HTTPS
certificates.

Compatibility is tested against `@vercel/blob` 2.8.2.

The following features work out of the box via `VERCEL_BLOB_API_URL`:

- `put`
- `head`
- `get` with the returned blob URL
- `list`
- `del`
- `copy`
- `rename`
- folder creation
- multipart uploads

### Reading blobs

With `@vercel/blob` 2.8.2, `get(url)` accepts URLs whose origin matches
`VERCEL_BLOB_API_URL`. Pass the local `url` returned by `put`, `head`, or
`list`. The `get(pathname)` form still generates a Vercel storage hostname
and does not route locally.

To read a private blob:

```ts
import { get, head } from "@vercel/blob";

const metadata = await head("wares/example.jpg");
const result = await get(metadata.url, { access: "private" });
if (result?.statusCode === 200) {
	const contents = await new Response(result.stream).arrayBuffer();
}
```

The local asset server handles:

- `GET` and `HEAD` requests
- bearer token validation for private blobs
- private cache directives for private blobs, including legacy volumes
- cache validation (`If-None-Match` / `304 Not Modified`)
- standard headers (`ETag`, `Last-Modified`, `Cache-Control`, `Content-Type`,
  `Content-Length`, `Content-Disposition`)
- the `?download=1` query parameter, matching `getDownloadUrl(url)` by
  returning an attachment disposition

## Development

Development and builds use Node.js 24 LTS (24.11.0 or newer) and pnpm 12.14.0.
Run `corepack enable` to use the pinned pnpm version. The workspace settings
explicitly allow esbuild's installation script, which pnpm requires for a
non-interactive install.

```bash
pnpm install
pnpm run check
pnpm run docker:build
```

Licensed under MIT. The project is marked `private` in `package.json` because
it is distributed as a Docker image rather than an npm package.
