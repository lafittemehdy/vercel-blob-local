import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";

import {
	BlobError,
	BlobNotFoundError,
	completeMultipartUpload,
	copy,
	createFolder,
	createMultipartUpload,
	del,
	get,
	head,
	list,
	type Part,
	put,
	runWithBaseUrl,
	uploadPart,
} from "./index.js";
import {
	LOCALHOST,
	getHeader,
	getPublicBaseUrl,
	getRequestBaseUrl,
	normalizePublicBaseUrl,
	parsePort,
	readBearerToken,
	readBody,
	readCreateOptions,
	requireHeader,
	requireSearchParam,
	sendError,
	sendJson,
} from "./http.js";

async function handleDelete(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	const parsed = JSON.parse(body.toString("utf8")) as { urls?: unknown };

	if (!Array.isArray(parsed.urls) && typeof parsed.urls !== "string") {
		throw new BlobError("urls is required");
	}

	const ifMatch = getHeader(request, "x-if-match");
	const token = readBearerToken(request);

	await del(parsed.urls as string[] | string, {
		...(ifMatch ? { ifMatch } : {}),
		...(token ? { token } : {}),
	});
	sendJson(response, 200, {});
}

async function handleApiGet(
	request: IncomingMessage,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const urlOrPathname = url.searchParams.get("url");
	const token = readBearerToken(request);

	if (urlOrPathname !== null) {
		sendJson(
			response,
			200,
			await head(urlOrPathname, token ? { token } : undefined),
		);
		return;
	}

	const options: {
		cursor?: string;
		limit?: number;
		mode?: "expanded" | "folded";
		prefix?: string;
		token?: string;
	} = {};
	const cursor = url.searchParams.get("cursor");
	const limit = url.searchParams.get("limit");
	const mode = url.searchParams.get("mode");
	const prefix = url.searchParams.get("prefix");

	if (cursor !== null) {
		options.cursor = cursor;
	}

	if (limit !== null) {
		options.limit = Number(limit);
	}

	if (mode === "expanded" || mode === "folded") {
		options.mode = mode;
	}

	if (prefix !== null) {
		options.prefix = prefix;
	}

	if (token !== undefined) {
		options.token = token;
	}

	sendJson(response, 200, await list(options));
}

async function handlePut(
	request: IncomingMessage,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const pathname = requireSearchParam(url, "pathname");
	const fromUrl = url.searchParams.get("fromUrl");
	const options = readCreateOptions(request);

	if (fromUrl !== null) {
		sendJson(response, 200, await copy(fromUrl, pathname, options));
		return;
	}

	const body = await readBody(request);

	if (body.length === 0 && pathname.endsWith("/")) {
		sendJson(response, 200, await createFolder(pathname, options));
		return;
	}

	sendJson(response, 200, await put(pathname, body, options));
}

async function handleMultipart(
	request: IncomingMessage,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const pathname = requireSearchParam(url, "pathname");
	const options = readCreateOptions(request);
	const action = requireHeader(request, "x-mpu-action");

	switch (action) {
		case "create":
			sendJson(response, 200, await createMultipartUpload(pathname, options));
			return;

		case "upload": {
			const key = decodeURIComponent(requireHeader(request, "x-mpu-key"));
			const uploadId = requireHeader(request, "x-mpu-upload-id");
			const partNumber = Number(requireHeader(request, "x-mpu-part-number"));
			const body = await readBody(request);

			if (!Number.isInteger(partNumber) || partNumber < 1) {
				throw new BlobError("x-mpu-part-number header is invalid");
			}

			sendJson(
				response,
				200,
				await uploadPart(pathname, body, {
					...options,
					key,
					partNumber,
					uploadId,
				}),
			);
			return;
		}

		case "complete": {
			const key = decodeURIComponent(requireHeader(request, "x-mpu-key"));
			const uploadId = requireHeader(request, "x-mpu-upload-id");
			const body = await readBody(request);
			const parts = JSON.parse(body.toString("utf8")) as Part[];

			sendJson(
				response,
				200,
				await completeMultipartUpload(pathname, parts, {
					...options,
					key,
					uploadId,
				}),
			);
			return;
		}

		default:
			throw new BlobError(`Unsupported multipart action: ${action}`);
	}
}

function pathnameFromDirectUrl(url: URL): string {
	return decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
}

function downloadContentDisposition(pathname: string): string {
	return `attachment; filename="${basename(pathname)}"`;
}

async function handleDirectRead(
	request: IncomingMessage,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const pathname = pathnameFromDirectUrl(url);
	const shouldDownload = url.searchParams.get("download") === "1";
	const ifNoneMatch = getHeader(request, "if-none-match");
	const token = readBearerToken(request);
	const result = await get(pathname, {
		access: "private",
		...(ifNoneMatch ? { ifNoneMatch } : {}),
		...(token ? { token } : {}),
	});

	if (!result) {
		throw new BlobNotFoundError();
	}

	result.headers.forEach((value, key) => {
		response.setHeader(key, value);
	});
	if (shouldDownload) {
		response.setHeader("content-disposition", downloadContentDisposition(pathname));
	}
	response.setHeader("last-modified", result.blob.uploadedAt.toUTCString());
	response.statusCode = result.statusCode;

	if (result.statusCode === 304 || request.method === "HEAD") {
		response.end();
		return;
	}

	Readable.fromWeb(
		result.stream as import("node:stream/web").ReadableStream<Uint8Array>,
	).pipe(response);
}

async function routeRequest(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", getRequestBaseUrl(request));

	return runWithBaseUrl(getPublicBaseUrl(request), async () => {
		if (request.method === "GET" && url.pathname === "/health") {
			sendJson(response, 200, { ok: true });
			return;
		}

		if (request.method === "POST" && url.pathname === "/delete") {
			await handleDelete(request, response);
			return;
		}

		if (request.method === "POST" && url.pathname === "/mpu") {
			await handleMultipart(request, url, response);
			return;
		}

		if (url.pathname === "/" && request.method === "GET") {
			await handleApiGet(request, url, response);
			return;
		}

		if (url.pathname === "/" && request.method === "PUT") {
			await handlePut(request, url, response);
			return;
		}

		if (
			url.pathname !== "/" &&
			(request.method === "GET" || request.method === "HEAD")
		) {
			await handleDirectRead(request, url, response);
			return;
		}

		throw new BlobNotFoundError();
	});
}

export function createVercelBlobLocalServer(): ReturnType<typeof createServer> {
	return createServer((request, response) => {
		void routeRequest(request, response).catch((error: unknown) => {
			sendError(response, error);
		});
	});
}

function main(): void {
	const port = parsePort(
		process.env.PORT ?? process.env.VERCEL_BLOB_LOCAL_PORT,
	);
	const host = process.env.HOST ?? "0.0.0.0";
	const configuredPublicUrl = process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL
		? normalizePublicBaseUrl(process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL)
		: null;
	const server = createVercelBlobLocalServer();

	server.listen(port, host, () => {
		const address = server.address();
		const actualPort =
			typeof address === "object" && address ? address.port : port;
		const publicUrl =
			configuredPublicUrl ?? `http://${LOCALHOST}:${actualPort}`;

		process.env.VERCEL_BLOB_LOCAL_BASE_URL = normalizePublicBaseUrl(publicUrl);
		console.log(`[vercel-blob-local] Listening on ${host}:${actualPort}`);
		console.log(
			`[vercel-blob-local] Public URL: ${process.env.VERCEL_BLOB_LOCAL_BASE_URL}`,
		);
	});
}

const executedFile = process.argv[1] ? basename(process.argv[1]) : "";

if (executedFile === "server.js" || executedFile === "server.cjs") {
	try {
		main();
	} catch (error) {
		console.error(
			`[vercel-blob-local] ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
