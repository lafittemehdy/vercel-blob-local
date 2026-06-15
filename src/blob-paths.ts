import { isAbsolute, relative, resolve } from "node:path";

import { BlobError, BlobPathnameMismatchError } from "./errors.js";

const FOLDER_MARKER_FILENAME = ".vercel-blob-local-folder";
const MAXIMUM_PATHNAME_LENGTH = 950;
const METADATA_DIR = ".metadata";
const MULTIPART_DIR = ".multipart";

export function getStorageRoot(): string {
	return resolve(process.env.VERCEL_BLOB_LOCAL_DIR ?? ".vercel-blob-local");
}

function pathnameFromUrlOrPathname(urlOrPathname: string): string {
	try {
		const parsed = new URL(urlOrPathname);
		return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
	} catch {
		return urlOrPathname.replace(/^\/+/, "");
	}
}

export function normalizePathname(urlOrPathname: string): string {
	const pathname = pathnameFromUrlOrPathname(urlOrPathname)
		.replaceAll("\\", "/")
		.replace(/^\/+/, "");
	const hasTrailingSlash = pathname.endsWith("/");

	if (!pathname || pathname.includes("\0")) {
		throw new BlobPathnameMismatchError("Blob pathname is invalid");
	}

	if (pathname.length > MAXIMUM_PATHNAME_LENGTH) {
		throw new BlobError(
			`pathname is too long, maximum length is ${MAXIMUM_PATHNAME_LENGTH}`,
		);
	}

	if (pathname.includes("//")) {
		throw new BlobError(
			'pathname cannot contain "//", please encode it if needed',
		);
	}

	const parts = pathname.split("/").filter(Boolean);

	if (parts.some((part) => part === "." || part === "..")) {
		throw new BlobPathnameMismatchError("Blob pathname cannot escape storage");
	}

	return `${parts.join("/")}${hasTrailingSlash ? "/" : ""}`;
}

export function resolveDataPath(pathname: string): string {
	const root = getStorageRoot();
	const storagePathname = pathname.endsWith("/")
		? `${pathname}${FOLDER_MARKER_FILENAME}`
		: pathname;
	const absolutePath = resolve(root, storagePathname);
	const relativePath = relative(root, absolutePath);

	if (
		relativePath === "" ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	) {
		throw new BlobPathnameMismatchError("Blob pathname escapes storage");
	}

	return absolutePath;
}

export function metadataPath(pathname: string): string {
	return resolve(
		getStorageRoot(),
		METADATA_DIR,
		Buffer.from(pathname, "utf8").toString("base64url"),
	);
}

export function metadataRoot(): string {
	return resolve(getStorageRoot(), METADATA_DIR);
}

export function multipartRoot(uploadId: string): string {
	return resolve(getStorageRoot(), MULTIPART_DIR, normalizePathname(uploadId));
}

export function multipartMetadataPath(uploadId: string): string {
	return resolve(multipartRoot(uploadId), "metadata.json");
}

export function multipartPartPath(
	uploadId: string,
	partNumber: number,
): string {
	return resolve(multipartRoot(uploadId), `${partNumber}.part`);
}
