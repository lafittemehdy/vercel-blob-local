import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { Readable } from "node:stream";

import {
	BlobAccessError,
	BlobError,
	BlobFileTooLargeError,
	BlobRequestAbortedError,
} from "./errors.js";
import type { BlobCommandOptions, PutBody } from "./types.js";

const DEFAULT_CACHE_CONTROL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function getExpectedToken(): string {
	const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();

	if (!token) {
		throw new BlobAccessError("BLOB_READ_WRITE_TOKEN is required");
	}

	return token;
}

export function assertAuthorized(options?: BlobCommandOptions): void {
	const expectedToken = getExpectedToken();

	if (options?.token !== expectedToken) {
		throw new BlobAccessError();
	}
}

export function inferContentType(pathname: string): string {
	switch (extname(pathname).toLowerCase()) {
		case ".avif":
			return "image/avif";
		case ".gif":
			return "image/gif";
		case ".html":
			return "text/html; charset=utf-8";
		case ".jpeg":
		case ".jpg":
			return "image/jpeg";
		case ".json":
			return "application/json";
		case ".mp4":
			return "video/mp4";
		case ".pdf":
			return "application/pdf";
		case ".png":
			return "image/png";
		case ".txt":
			return "text/plain; charset=utf-8";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

export function buildCacheControl(maxAge?: number): string {
	if (maxAge !== undefined && maxAge < 60) {
		throw new BlobError("cacheControlMaxAge cannot be lower than 60 seconds");
	}

	return `public, max-age=${maxAge ?? DEFAULT_CACHE_CONTROL_MAX_AGE_SECONDS}`;
}

export function addRandomSuffix(pathname: string): string {
	const extension = extname(pathname);
	const stem = extension ? pathname.slice(0, -extension.length) : pathname;
	return `${stem}-${randomBytes(4).toString("hex")}${extension}`;
}

export async function assertNotAborted(
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		throw new BlobRequestAbortedError();
	}
}

export async function bodyToBuffer(body: PutBody): Promise<Buffer> {
	if (Buffer.isBuffer(body)) {
		return body;
	}

	if (typeof body === "string") {
		return Buffer.from(body);
	}

	if (body instanceof ArrayBuffer) {
		return Buffer.from(body);
	}

	if (body instanceof Blob) {
		return Buffer.from(await body.arrayBuffer());
	}

	if (body instanceof ReadableStream) {
		const reader = body.getReader();
		const chunks: Buffer[] = [];

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			chunks.push(Buffer.from(value));
		}

		return Buffer.concat(chunks);
	}

	if (body instanceof Readable || Symbol.asyncIterator in body) {
		const chunks: Buffer[] = [];

		for await (const chunk of body as AsyncIterable<Buffer | string>) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		return Buffer.concat(chunks);
	}

	throw new BlobError("Unsupported blob body");
}

export function assertWithinMaximumSize(
	buffer: Buffer,
	maximumSize?: number,
): void {
	if (maximumSize !== undefined && buffer.length > maximumSize) {
		throw new BlobFileTooLargeError(
			`Blob is larger than the maximum size of ${maximumSize} bytes`,
		);
	}
}
