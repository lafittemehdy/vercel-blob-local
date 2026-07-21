import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { BlobError, BlobPathnameMismatchError } from "./errors.js";

const FOLDER_MARKER_FILENAME = ".vercel-blob-local-folder";
const MAXIMUM_PATHNAME_LENGTH = 950;
const CLEANUP_DIR = ".cleanup";
const DATA_DIR = ".data";
const METADATA_DIR = ".metadata";
const MULTIPART_DIR = ".multipart";
const RESERVED_TOP_LEVEL_DIRECTORIES = new Set([
	CLEANUP_DIR,
	DATA_DIR,
	METADATA_DIR,
	MULTIPART_DIR,
]);
const RESERVED_SERVICE_PATHNAMES = new Set(["health"]);

export function getStorageRoot(): string {
	return resolve(process.env.VERCEL_BLOB_LOCAL_DIR ?? ".vercel-blob-local");
}

function pathnameFromUrlOrPathname(urlOrPathname: string): string {
	if (/^[a-z][a-z\d+.-]*:\/\//iu.test(urlOrPathname)) {
		const parsed = new URL(urlOrPathname);
		return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
	}

	return urlOrPathname.replace(/^\/+/, "");
}

export function normalizePathname(urlOrPathname: string): string {
	const pathname = pathnameFromUrlOrPathname(urlOrPathname)
		.replaceAll("\\", "/")
		.replace(/^\/+/, "");
	const hasTrailingSlash = pathname.endsWith("/");

	if (
		!pathname ||
		!pathname.isWellFormed() ||
		/[\u0000-\u001f\u007f]/u.test(pathname)
	) {
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

	const [topLevelDirectory] = parts;

	if (
		topLevelDirectory &&
		RESERVED_TOP_LEVEL_DIRECTORIES.has(topLevelDirectory.toLowerCase())
	) {
		throw new BlobPathnameMismatchError(
			"Blob pathname uses a reserved storage namespace",
		);
	}

	const normalizedPathname = `${parts.join("/")}${hasTrailingSlash ? "/" : ""}`;

	if (RESERVED_SERVICE_PATHNAMES.has(normalizedPathname.toLowerCase())) {
		throw new BlobPathnameMismatchError(
			"Blob pathname conflicts with a reserved service endpoint",
		);
	}

	return normalizedPathname;
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

export function resolveStoredDataPath(
	pathname: string,
	dataFile?: string,
): string {
	if (dataFile === undefined) {
		return resolveDataPath(pathname);
	}

	if (
		basename(dataFile) !== dataFile ||
		!/^[.]vercel-blob-local-data-[a-f0-9]{32}[.]blob$/u.test(dataFile)
	) {
		throw new BlobPathnameMismatchError("Stored blob data path is invalid");
	}

	return resolve(getStorageRoot(), DATA_DIR, dataFile);
}

export function metadataPath(pathname: string): string {
	return resolve(
		getStorageRoot(),
		METADATA_DIR,
		`v2-${createHash("sha256").update(pathname).digest("hex")}.json`,
	);
}

export function legacyMetadataPath(pathname: string): string {
	return resolve(
		getStorageRoot(),
		METADATA_DIR,
		Buffer.from(pathname, "utf8").toString("base64url"),
	);
}

export function metadataRoot(): string {
	return resolve(getStorageRoot(), METADATA_DIR);
}

export function dataRoot(): string {
	return resolve(getStorageRoot(), DATA_DIR);
}

export function cleanupRoot(): string {
	return resolve(getStorageRoot(), CLEANUP_DIR);
}

export function multipartStorageRoot(): string {
	return resolve(getStorageRoot(), MULTIPART_DIR);
}

export function multipartRoot(uploadId: string): string {
	if (!/^[a-f0-9]{32}$/u.test(uploadId)) {
		throw new BlobPathnameMismatchError("Multipart upload ID is invalid");
	}

	return resolve(multipartStorageRoot(), uploadId);
}

export function multipartMetadataPath(uploadId: string): string {
	return resolve(multipartRoot(uploadId), "metadata.json");
}

export function multipartPartPath(
	uploadId: string,
	partNumber: number,
): string {
	if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
		throw new BlobError("Multipart part number must be a positive integer");
	}

	return resolve(multipartRoot(uploadId), `${partNumber}.part`);
}

export function cleanupRecordPath(pathname: string): string {
	return resolve(
		cleanupRoot(),
		`v2-${createHash("sha256").update(pathname).digest("hex")}.json`,
	);
}
