import type { IncomingMessage, ServerResponse } from "node:http";

import {
	BlobAccessError,
	BlobError,
	BlobFileTooLargeError,
	BlobNotFoundError,
	BlobPathnameMismatchError,
	BlobPreconditionFailedError,
	BlobRequestAbortedError,
	BlobServiceNotAvailable,
	BlobServiceRateLimited,
	BlobStoreNotFoundError,
	BlobStoreSuspendedError,
	BlobUnknownError,
} from "./errors.js";
import type { BlobAccessType } from "./types.js";

export type CreateOptions = {
	abortSignal?: AbortSignal;
	access: BlobAccessType;
	addRandomSuffix?: boolean;
	allowOverwrite?: boolean;
	cacheControlMaxAge?: number;
	contentType?: string;
	ifMatch?: string;
	token?: string;
};

export const DEFAULT_PORT = 3000;
export const LOCALHOST = "localhost";

export function getHeader(
	request: IncomingMessage,
	name: string,
): string | undefined {
	const value = request.headers[name.toLowerCase()];

	if (Array.isArray(value)) {
		return value[0];
	}

	return value;
}

export function getRequestBaseUrl(request: IncomingMessage): string {
	const protocol = getHeader(request, "x-forwarded-proto") ?? "http";
	const host = getHeader(request, "host") ?? `${LOCALHOST}:${DEFAULT_PORT}`;
	return `${protocol}://${host}`;
}

export function normalizePublicBaseUrl(value: string): string {
	const url = new URL(value);

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlobError("VERCEL_BLOB_LOCAL_PUBLIC_URL must use http or https");
	}

	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new BlobError("VERCEL_BLOB_LOCAL_PUBLIC_URL must be an origin");
	}

	return url.origin;
}

export function getPublicBaseUrl(request: IncomingMessage): string {
	return normalizePublicBaseUrl(
		process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL ?? getRequestBaseUrl(request),
	);
}

export function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: unknown,
): void {
	const body = JSON.stringify(payload);

	response.writeHead(statusCode, {
		"content-length": Buffer.byteLength(body),
		"content-type": "application/json; charset=utf-8",
	});
	response.end(body);
}

export function sendError(response: ServerResponse, error: unknown): void {
	const { code, message, statusCode } = mapError(error);
	const headers: Record<string, string> = {};

	if (error instanceof BlobServiceRateLimited && error.retryAfter) {
		headers["retry-after"] = String(error.retryAfter);
	}

	const body = JSON.stringify({ error: { code, message } });

	response.writeHead(statusCode, {
		"content-length": Buffer.byteLength(body),
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(body);
}

function mapError(error: unknown): {
	code: string;
	message: string;
	statusCode: number;
} {
	const message = error instanceof Error ? error.message : "Unknown error";

	if (error instanceof BlobNotFoundError) {
		return { code: "not_found", message, statusCode: 404 };
	}

	if (error instanceof BlobPreconditionFailedError) {
		return { code: "precondition_failed", message, statusCode: 412 };
	}

	if (error instanceof BlobAccessError) {
		return { code: "forbidden", message, statusCode: 403 };
	}

	if (error instanceof BlobFileTooLargeError) {
		return { code: "file_too_large", message, statusCode: 413 };
	}

	if (error instanceof BlobStoreNotFoundError) {
		return { code: "store_not_found", message, statusCode: 404 };
	}

	if (error instanceof BlobStoreSuspendedError) {
		return { code: "store_suspended", message, statusCode: 403 };
	}

	if (error instanceof BlobServiceRateLimited) {
		return { code: "rate_limited", message, statusCode: 429 };
	}

	if (error instanceof BlobServiceNotAvailable) {
		return { code: "service_unavailable", message, statusCode: 503 };
	}

	if (error instanceof BlobRequestAbortedError) {
		return { code: "request_aborted", message, statusCode: 499 };
	}

	if (error instanceof BlobUnknownError) {
		return { code: "unknown_error", message, statusCode: 500 };
	}

	if (error instanceof BlobPathnameMismatchError || error instanceof BlobError) {
		return { code: "bad_request", message, statusCode: 400 };
	}

	return { code: "unknown_error", message, statusCode: 500 };
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];

	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks);
}

export function requireSearchParam(url: URL, name: string): string {
	const value = url.searchParams.get(name);

	if (!value) {
		throw new BlobError(`${name} is required`);
	}

	return value;
}

export function requireHeader(request: IncomingMessage, name: string): string {
	const value = getHeader(request, name);

	if (!value) {
		throw new BlobError(`${name} header is required`);
	}

	return value;
}

export function readBearerToken(
	request: IncomingMessage,
): string | undefined {
	const authorization = getHeader(request, "authorization");
	const match = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization) : null;
	return match?.[1]?.trim() || undefined;
}

function readBooleanHeader(
	request: IncomingMessage,
	name: string,
): boolean | undefined {
	const value = getHeader(request, name);

	if (value === undefined) {
		return undefined;
	}

	return value === "1" || value.toLowerCase() === "true";
}

function readNumberHeader(
	request: IncomingMessage,
	name: string,
): number | undefined {
	const value = getHeader(request, name);

	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);

	if (!Number.isFinite(parsed)) {
		throw new BlobError(`${name} header must be a number`);
	}

	return parsed;
}

function readAccess(request: IncomingMessage): BlobAccessType {
	const value = getHeader(request, "x-vercel-blob-access");

	if (value === undefined) {
		return "public";
	}

	if (value === "public" || value === "private") {
		return value;
	}

	throw new BlobError('x-vercel-blob-access must be "public" or "private"');
}

export function readCreateOptions(request: IncomingMessage): CreateOptions {
	const options: CreateOptions = {
		access: readAccess(request),
	};
	const token = readBearerToken(request);
	const addRandomSuffix = readBooleanHeader(request, "x-add-random-suffix");
	const allowOverwrite = readBooleanHeader(request, "x-allow-overwrite");
	const cacheControlMaxAge = readNumberHeader(
		request,
		"x-cache-control-max-age",
	);
	const contentType = getHeader(request, "x-content-type");
	const ifMatch = getHeader(request, "x-if-match");

	if (addRandomSuffix !== undefined) {
		options.addRandomSuffix = addRandomSuffix;
	}

	if (allowOverwrite !== undefined) {
		options.allowOverwrite = allowOverwrite;
	}

	if (cacheControlMaxAge !== undefined) {
		options.cacheControlMaxAge = cacheControlMaxAge;
	}

	if (contentType !== undefined) {
		options.contentType = contentType;
	}

	if (ifMatch !== undefined) {
		options.ifMatch = ifMatch;
	}

	if (token !== undefined) {
		options.token = token;
	}

	return options;
}

export function parsePort(value: string | undefined): number {
	const port = Number(value ?? DEFAULT_PORT);

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${value}`);
	}

	return port;
}
