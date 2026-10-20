import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	buildCacheControl,
	buildContentDisposition,
	inferContentType,
} from "./blob-constraints.js";
import {
	legacyMetadataPath,
	metadataPath,
	metadataRoot,
	normalizePathname,
	resolveStoredDataPath,
} from "./blob-paths.js";
import { buildUrl, getDownloadUrl } from "./blob-urls.js";
import { BlobNotFoundError, BlobServiceNotAvailable } from "./errors.js";
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
	dataFile?: string;
	etag: string;
	pathname: string;
	size: number;
	uploadedAt: string;
};

export type StoredMetadataRecord = {
	metadata: StoredMetadata;
	storagePath: string;
};

export type StoredMetadataScan = {
	complete: boolean;
	dataStoragePathRefCounts: Map<string, number>;
	invalidStoragePaths: Set<string>;
	recordsByStoragePath: Map<string, StoredMetadataRecord>;
};

const METADATA_SCAN_CONCURRENCY = 32;

export function comparePathnames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

let cachedMetadataScan:
	| { promise: Promise<StoredMetadataScan>; root: string }
	| undefined;

export function buildMetadata(
	pathname: string,
	file: { dataFile?: string; etag: string; size: number },
	options: CommonCreateBlobOptions,
): StoredMetadata {
	return {
		access: options.access,
		cacheControl: buildCacheControl(options.access, options.cacheControlMaxAge),
		contentDisposition: buildContentDisposition(pathname),
		contentType: options.contentType ?? inferContentType(pathname),
		...(file.dataFile === undefined ? {} : { dataFile: file.dataFile }),
		etag: file.etag,
		pathname,
		size: file.size,
		uploadedAt: new Date().toISOString(),
	};
}

function storagePathKey(storagePath: string): string {
	const absolutePath = resolve(storagePath);
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

function recordsForPathname(
	scan: StoredMetadataScan,
	pathname: string,
): StoredMetadataRecord[] {
	const records: StoredMetadataRecord[] = [];

	for (const storagePath of [metadataPath(pathname), legacyMetadataPath(pathname)]) {
		const key = storagePathKey(storagePath);

		if (scan.dataStoragePathRefCounts.has(key)) {
			continue;
		}

		if (scan.invalidStoragePaths.has(key)) {
			throw new BlobServiceNotAvailable();
		}

		const record = scan.recordsByStoragePath.get(key);

		if (record?.metadata.pathname === pathname) {
			records.push(record);
		}
	}

	return records;
}

export async function readMetadataRecords(
	pathname: string,
): Promise<StoredMetadataRecord[]> {
	return recordsForPathname(await getStoredMetadataScan(), pathname);
}

export async function assertMetadataPathWritable(pathname: string): Promise<void> {
	const scan = await getStoredMetadataScan();
	const currentPathKey = storagePathKey(metadataPath(pathname));

	if (
		scan.dataStoragePathRefCounts.has(currentPathKey) ||
		scan.invalidStoragePaths.has(currentPathKey)
	) {
		throw new BlobServiceNotAvailable();
	}
}

export async function readMetadataRecord(
	pathname: string,
): Promise<StoredMetadataRecord> {
	const [record] = await readMetadataRecords(pathname);

	if (!record) {
		throw new BlobNotFoundError();
	}

	return record;
}

export async function readMetadata(pathname: string): Promise<StoredMetadata> {
	return (await readMetadataRecord(pathname)).metadata;
}

export async function readLegacyMetadata(
	pathname: string,
): Promise<StoredMetadata | null> {
	const legacyPathKey = storagePathKey(legacyMetadataPath(pathname));
	const legacy = (await readMetadataRecords(pathname)).find(
		(record) => storagePathKey(record.storagePath) === legacyPathKey,
	);
	return legacy?.metadata ?? null;
}

export async function removeLegacyMetadata(
	pathname: string,
): Promise<StoredMetadata | null> {
	const legacyPathKey = storagePathKey(legacyMetadataPath(pathname));
	const records = await readMetadataRecords(pathname);
	const legacy = records.find(
		(record) => storagePathKey(record.storagePath) === legacyPathKey,
	);

	if (!legacy) {
		return null;
	}

	await rm(legacy.storagePath, { force: true });
	await replaceStoredMetadataRecords(
		pathname,
		records.filter((record) => record !== legacy),
	);
	return legacy.metadata;
}

export function metadataToHeadResult(
	metadata: StoredMetadata,
): HeadBlobResult {
	return {
		cacheControl: metadata.access === "private"
			? metadata.cacheControl.replace(/^public\b/u, "private")
			: metadata.cacheControl,
		contentDisposition: buildContentDisposition(metadata.pathname),
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
		contentDisposition: buildContentDisposition(metadata.pathname),
		contentType: metadata.contentType,
		downloadUrl: getDownloadUrl(metadata.pathname),
		etag: metadata.etag,
		pathname: metadata.pathname,
		url: buildUrl(metadata.pathname),
	};
}

export async function listMetadataRecords(): Promise<StoredMetadataRecord[]> {
	const scan = await getStoredMetadataScan();
	const pathnames = new Set<string>();

	for (const { metadata } of scan.recordsByStoragePath.values()) {
		try {
			if (normalizePathname(metadata.pathname) === metadata.pathname) {
				pathnames.add(metadata.pathname);
			}
		} catch {
			console.warn(
				`[vercel-blob-local] Skipping unsupported legacy blob pathname ${JSON.stringify(metadata.pathname)}`,
			);
		}
	}

	const records: StoredMetadataRecord[] = [];

	for (const pathname of [...pathnames].sort(comparePathnames)) {
		try {
			const [record] = recordsForPathname(scan, pathname);

			if (record) {
				records.push(record);
			}
		} catch (error) {
			console.warn(
				`[vercel-blob-local] Skipping unreadable blob metadata for ${JSON.stringify(pathname)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return records;
}

export function invalidateStoredMetadataScan(): void {
	cachedMetadataScan = undefined;
}

export function getStoredMetadataScan(): Promise<StoredMetadataScan> {
	const root = metadataRoot();

	if (cachedMetadataScan?.root === root) {
		return cachedMetadataScan.promise;
	}

	const promise = scanStoredMetadataRecords();
	const pending = { promise, root };
	cachedMetadataScan = pending;
	void promise.then(
		(scan) => {
			if (!scan.complete && cachedMetadataScan === pending) {
				cachedMetadataScan = undefined;
			}
		},
		() => {
			if (cachedMetadataScan === pending) {
				cachedMetadataScan = undefined;
			}
		},
	);
	return promise;
}

export function cacheStoredMetadataScan(scan: StoredMetadataScan): void {
	cachedMetadataScan = {
		promise: Promise.resolve(scan),
		root: metadataRoot(),
	};
}

function dataStoragePathKey(record: StoredMetadataRecord): string {
	return storagePathKey(
		resolveStoredDataPath(record.metadata.pathname, record.metadata.dataFile),
	);
}

function adjustRefCount(
	refCounts: Map<string, number>,
	key: string,
	delta: 1 | -1,
): void {
	const nextCount = (refCounts.get(key) ?? 0) + delta;

	if (nextCount > 0) {
		refCounts.set(key, nextCount);
		return;
	}

	refCounts.delete(key);
}

export async function replaceStoredMetadataRecords(
	pathname: string,
	records: StoredMetadataRecord[],
): Promise<void> {
	const current = cachedMetadataScan;
	const root = metadataRoot();

	if (!current || current.root !== root) {
		return;
	}

	const scan = await current.promise;

	if (cachedMetadataScan !== current) {
		return;
	}

	if (!scan.complete) {
		invalidateStoredMetadataScan();
		return;
	}

	const replacementStorageKeys = new Set(
		[metadataPath(pathname), legacyMetadataPath(pathname)].map(storagePathKey),
	);
	const replacementRecords = new Map<string, StoredMetadataRecord>();

	for (const record of records) {
		const key = storagePathKey(record.storagePath);

		if (!replacementStorageKeys.has(key)) {
			invalidateStoredMetadataScan();
			return;
		}

		replacementRecords.set(key, record);
	}

	const removedRecords = [...replacementStorageKeys]
		.map((key) => scan.recordsByStoragePath.get(key))
		.filter((record): record is StoredMetadataRecord => record !== undefined);
	const removedDataCounts = new Map<string, number>();
	const addedDataCounts = new Map<string, number>();

	for (const record of removedRecords) {
		const key = dataStoragePathKey(record);
		removedDataCounts.set(key, (removedDataCounts.get(key) ?? 0) + 1);
	}

	for (const record of replacementRecords.values()) {
		const key = dataStoragePathKey(record);
		addedDataCounts.set(key, (addedDataCounts.get(key) ?? 0) + 1);
	}

	const prospectiveDataCount = (key: string): number =>
		(scan.dataStoragePathRefCounts.get(key) ?? 0) -
		(removedDataCounts.get(key) ?? 0) +
		(addedDataCounts.get(key) ?? 0);
	const prospectiveStorageHas = (key: string): boolean =>
		replacementRecords.has(key) ||
		(!replacementStorageKeys.has(key) && scan.recordsByStoragePath.has(key));

	if (
		[...replacementRecords.keys()].some(
			(key) => prospectiveDataCount(key) > 0,
		) ||
		[...addedDataCounts.keys()].some(prospectiveStorageHas)
	) {
		invalidateStoredMetadataScan();
		return;
	}

	for (const [key, count] of removedDataCounts) {
		for (let index = 0; index < count; index += 1) {
			adjustRefCount(scan.dataStoragePathRefCounts, key, -1);
		}
	}

	for (const key of replacementStorageKeys) {
		scan.recordsByStoragePath.delete(key);
	}

	for (const [key, record] of replacementRecords) {
		scan.recordsByStoragePath.set(key, record);
	}

	for (const [key, count] of addedDataCounts) {
		for (let index = 0; index < count; index += 1) {
			adjustRefCount(scan.dataStoragePathRefCounts, key, 1);
		}
	}
}

function isMetadataFilename(filename: string): boolean {
	return (
		/^[A-Za-z0-9_-]+$/u.test(filename) ||
		/^v2-[a-f0-9]{64}[.]json$/iu.test(filename)
	);
}

function logInvalidMetadata(filename: string, error: unknown): void {
	console.warn(
		`[vercel-blob-local] Skipping invalid metadata record ${filename}: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
}

function isStoredMetadata(
	metadata: Partial<StoredMetadata>,
): metadata is StoredMetadata {
	return (
		(metadata.access === "private" || metadata.access === "public") &&
		typeof metadata.cacheControl === "string" &&
		typeof metadata.contentDisposition === "string" &&
		typeof metadata.contentType === "string" &&
		(metadata.dataFile === undefined || typeof metadata.dataFile === "string") &&
		typeof metadata.etag === "string" &&
		/^[a-f0-9]{64}$/u.test(metadata.etag) &&
		typeof metadata.pathname === "string" &&
		Number.isSafeInteger(metadata.size) &&
		(metadata.size ?? -1) >= 0 &&
		typeof metadata.uploadedAt === "string" &&
		Number.isFinite(Date.parse(metadata.uploadedAt))
	);
}

export async function scanStoredMetadataRecords(): Promise<StoredMetadataScan> {
	const root = metadataRoot();
	let entries: Dirent<string>[];

	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				complete: true,
				dataStoragePathRefCounts: new Map(),
				invalidStoragePaths: new Set(),
				recordsByStoragePath: new Map(),
			};
		}

		throw error;
	}

	let complete = true;
	const candidates: Array<StoredMetadataRecord | undefined> = [];
	const invalidStoragePaths = new Set<string>();
	const metadataEntries = entries.filter((entry) =>
		isMetadataFilename(entry.name),
	);
	let nextEntryIndex = 0;
	const scanEntry = async (): Promise<void> => {
		while (nextEntryIndex < metadataEntries.length) {
			const index = nextEntryIndex;
			nextEntryIndex += 1;
			const entry = metadataEntries[index];

			if (!entry) {
				continue;
			}

			const storagePath = join(root, entry.name);

			if (!entry.isFile()) {
				complete = false;
				invalidStoragePaths.add(storagePathKey(storagePath));
				logInvalidMetadata(
					entry.name,
					new Error("recognized metadata entry is not a regular file"),
				);
				continue;
			}

			try {
				const raw = await readFile(storagePath, "utf8");
				const metadata = JSON.parse(raw) as Partial<StoredMetadata>;

				if (!isStoredMetadata(metadata)) {
					throw new Error("metadata fields are invalid");
				}

				const validPaths = [
					metadataPath(metadata.pathname),
					legacyMetadataPath(metadata.pathname),
				].map((validPath) => storagePathKey(validPath));

				if (!validPaths.includes(storagePathKey(storagePath))) {
					throw new Error("filename does not match pathname");
				}

				resolveStoredDataPath(metadata.pathname, metadata.dataFile);
				candidates[index] = {
					metadata,
					storagePath,
				};
			} catch (error) {
				complete = false;
				invalidStoragePaths.add(storagePathKey(storagePath));
				logInvalidMetadata(entry.name, error);
			}
		}
	};

	await Promise.all(
		Array.from(
			{
				length: Math.min(METADATA_SCAN_CONCURRENCY, metadataEntries.length),
			},
			scanEntry,
		),
	);

	const validCandidates = candidates.filter(
		(candidate): candidate is StoredMetadataRecord => candidate !== undefined,
	);
	const dataStoragePathRefCounts = new Map<string, number>();

	for (const candidate of validCandidates) {
		adjustRefCount(dataStoragePathRefCounts, dataStoragePathKey(candidate), 1);
	}

	const records: StoredMetadataRecord[] = [];

	for (const candidate of validCandidates) {
		if (
			dataStoragePathRefCounts.has(storagePathKey(candidate.storagePath))
		) {
			complete = false;
			console.warn(
				`[vercel-blob-local] Treating metadata-shaped entry ${candidate.storagePath} as legacy blob data`,
			);
			continue;
		}

		records.push(candidate);
	}
	const recordsByStoragePath = new Map(
		records.map((record) => [storagePathKey(record.storagePath), record]),
	);

	return {
		complete,
		dataStoragePathRefCounts,
		invalidStoragePaths,
		recordsByStoragePath,
	};
}
