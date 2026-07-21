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

Compatibility is tested against `@vercel/blob` 2.6.1.

The following features work out of the box via `VERCEL_BLOB_API_URL`:

- `put`
- `head`
- `list`
- `del`
- `copy`
- `rename`
- folder creation
- multipart uploads

### The `get()` Exception

The official SDK's `get(pathname)` helper generates a Vercel storage hostname,
such as `https://{storeId}.public.blob.vercel-storage.com/...`, and strictly
validates that direct URLs match this domain. Because this is hardcoded in the
SDK, `get()` cannot be routed locally using environment variables alone.

To read files during local development, fetch the direct `url` returned by
`put`, `head`, or `list` instead:

```ts
import { head } from "@vercel/blob";

const metadata = await head("wares/example.jpg");
const response = await fetch(metadata.url, {
	headers: {
		authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
	},
});
```

The local asset server handles:

- `GET` and `HEAD` requests
- bearer token validation for private blobs
- cache validation (`If-None-Match` / `304 Not Modified`)
- standard headers (`ETag`, `Last-Modified`, `Cache-Control`, `Content-Type`,
  `Content-Length`, `Content-Disposition`)
- the `?download=1` query parameter, matching `getDownloadUrl(url)` by
  returning an attachment disposition

This keeps your primary SDK interactions environment-swappable while working
around the one hostname-bound SDK limitation explicitly.

## Development

Development and builds use Node.js 24 LTS.

```bash
pnpm install
pnpm run check
pnpm run docker:build
```

Licensed under MIT. The project is marked `private` in `package.json` because
it is distributed as a Docker image rather than an npm package.
