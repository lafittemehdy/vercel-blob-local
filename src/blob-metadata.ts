import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { buildCacheControl, inferContentType } from "./blob-constraints.js";
import { metadataPath, metadataRoot } from "./blob-paths.js";
import { buildUrl, getDownloadUrl } from "./blob-urls.js";
import { BlobNotFoundError } from "./errors.js";
import type {
	BlobAccessType,
	CommonCreateBlobOptions,
	HeadBlobResult,
	PutBlobResult,
} from "./types.js";

export type StoredMetadata = {
	access: BlobAccessType;
	cacheControl: string;
	contentDisposition: string;
	contentType: string;
	etag: string;
	pathname: string;
	size: number;
	uploadedAt: string;
};

export function buildMetadata(
	pathname: string,
	buffer: Buffer,
	options: CommonCreateBlobOptions,
): StoredMetadata {
	const etag = createHash("sha256").update(buffer).digest("hex");

	return {
		access: options.access,
		cacheControl: buildCacheControl(options.cacheControlMaxAge),
		contentDisposition: `inline; filename="${basename(pathname)}"`,
		contentType: options.contentType ?? inferContentType(pathname),
		etag,
		pathname,
		size: buffer.length,
		uploadedAt: new Date().toISOString(),
	};
}

export async function readMetadata(
	pathname: string,
): Promise<StoredMetadata> {
	try {
		const raw = await readFile(metadataPath(pathname), "utf8");
		return JSON.parse(raw) as StoredMetadata;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlobNotFoundError();
		}

		throw error;
	}
}

export function metadataToHeadResult(
	metadata: StoredMetadata,
): HeadBlobResult {
	return {
		cacheControl: metadata.cacheControl,
		contentDisposition: metadata.contentDisposition,
		contentType: metadata.contentType,
		downloadUrl: getDownloadUrl(metadata.pathname),
		etag: metadata.etag,
		pathname: metadata.pathname,
		size: metadata.size,
		uploadedAt: new Date(metadata.uploadedAt),
		url: buildUrl(metadata.pathname),
	};
}

export function metadataToPutResult(
	metadata: StoredMetadata,
): PutBlobResult {
	return {
		contentDisposition: metadata.contentDisposition,
		contentType: metadata.contentType,
		downloadUrl: getDownloadUrl(metadata.pathname),
		etag: metadata.etag,
		pathname: metadata.pathname,
		url: buildUrl(metadata.pathname),
	};
}

export async function listMetadataPathnames(): Promise<string[]> {
	try {
		const entries = await readdir(metadataRoot());
		return entries
			.map((entry) => Buffer.from(entry, "base64url").toString("utf8"))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}

		throw error;
	}
}
