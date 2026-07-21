import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";

import {
	BlobAccessError,
	BlobError,
	BlobRequestAbortedError,
} from "./errors.js";
import type { BlobCommandOptions } from "./types.js";

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

export function buildContentDisposition(
	pathname: string,
	disposition: "attachment" | "inline" = "inline",
): string {
	const filename = basename(pathname);
	const fallbackFilename = filename
		.normalize("NFKD")
		.replaceAll(/[^\x20-\x7e]/gu, "_")
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"');
	const fallback = `${disposition}; filename="${fallbackFilename}"`;

	if (/^[\x20-\x7e]*$/u.test(filename)) {
		return fallback;
	}

	const encodedFilename = encodeURIComponent(filename).replaceAll(
		/['()*]/gu,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${fallback}; filename*=UTF-8''${encodedFilename}`;
}
