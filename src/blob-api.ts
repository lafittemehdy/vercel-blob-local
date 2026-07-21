import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	mkdir,
	open,
	readFile,
	readdir,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
	BlobError,
	BlobNotFoundError,
	BlobPathnameMismatchError,
	BlobPreconditionFailedError,
} from "./errors.js";
import {
	addRandomSuffix,
	assertAuthorized,
	assertNotAborted,
	buildContentDisposition,
} from "./blob-constraints.js";
import {
	publishStagedFile,
	removeStagedFile,
	stageBody,
	stageContents,
} from "./blob-files.js";
import {
	assertMetadataPathWritable,
	buildMetadata,
	cacheStoredMetadataScan,
	comparePathnames,
	getStoredMetadataScan,
	invalidateStoredMetadataScan,
	listMetadataRecords,
	metadataToHeadResult,
	metadataToPutResult,
	readLegacyMetadata,
	readMetadata,
	readMetadataRecord,
	readMetadataRecords,
	replaceStoredMetadataRecords,
	removeLegacyMetadata,
	scanStoredMetadataRecords,
	type StoredMetadata,
	type StoredMetadataRecord,
} from "./blob-metadata.js";
import {
	cleanupRecordPath,
	cleanupRoot,
	dataRoot,
	legacyMetadataPath,
	metadataPath,
	metadataRoot,
	multipartMetadataPath,
	multipartPartPath,
	multipartRoot,
	multipartStorageRoot,
	normalizePathname,
	resolveStoredDataPath,
} from "./blob-paths.js";
import { buildUrl, getDownloadUrl } from "./blob-urls.js";
import type {
	BlobAccessType,
	BlobCommandOptions,
	CommonCreateBlobOptions,
	CompleteMultipartUploadCommandOptions,
	CopyBlobResult,
	CopyCommandOptions,
	CreateFolderCommandOptions,
	CreateFolderResult,
	DeleteCommandOptions,
	GetBlobResult,
	GetCommandOptions,
	HeadBlobResult,
	ListBlobResult,
	ListCommandOptions,
	ListCommandResult,
	Part,
	PutBody,
	PutBlobResult,
	PutCommandOptions,
	RenameBlobResult,
	RenameCommandOptions,
	UploadPartCommandOptions,
} from "./types.js";

type MultipartMetadata = {
	access: BlobAccessType;
	cacheControlMaxAge?: number;
	contentType?: string;
	key: string;
	maximumSizeInBytes?: number;
	pathname: string;
	uploadId: string;
};

type DeletionRecord = {
	dataFiles: string[];
	etag?: string;
	pathname: string;
};

const pathnameLocks = new Map<string, Promise<void>>();
const CLEANUP_RECORD_FILENAME = /^v2-[a-f0-9]{64}[.]json$/u;
const GENERATION_DATA_FILENAME =
	/^[.]vercel-blob-local-data-[a-f0-9]{32}[.]blob$/u;
const STAGED_FILENAME = /^[.]vercel-blob-local-[a-f0-9]{24}[.]tmp$/u;

async function removeDataFile(dataPath: string): Promise<void> {
	const retryableCodes = new Set([
		"EACCES",
		"EBUSY",
		"EMFILE",
		"ENFILE",
		"EPERM",
	]);

	for (let attempt = 0; attempt <= 3; attempt += 1) {
		try {
			await unlink(dataPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;

			if (code === "ENOENT") {
				return;
			}

			if (attempt === 3 || !code || !retryableCodes.has(code)) {
				throw error;
			}

			await delay(50 * (attempt + 1));
		}
	}
}

function logCleanupFailure(dataPath: string, error: unknown): void {
	console.warn(
		`[vercel-blob-local] Unable to remove obsolete data file ${dataPath}: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
}

function parseDeletionRecord(raw: string): DeletionRecord {
	const parsed = JSON.parse(raw) as Partial<DeletionRecord>;

	if (
		typeof parsed.pathname !== "string" ||
		normalizePathname(parsed.pathname) !== parsed.pathname ||
		!Array.isArray(parsed.dataFiles) ||
		parsed.dataFiles.length === 0 ||
		parsed.dataFiles.some((dataFile) => typeof dataFile !== "string") ||
		(parsed.etag !== undefined &&
			(typeof parsed.etag !== "string" ||
				!/^[a-f0-9]{64}$/u.test(parsed.etag)))
	) {
		throw new BlobError("Stored blob cleanup record is invalid");
	}

	for (const dataFile of parsed.dataFiles) {
		resolveStoredDataPath(parsed.pathname, dataFile || undefined);
	}

	return {
		dataFiles: [...new Set(parsed.dataFiles)],
		...(parsed.etag === undefined ? {} : { etag: parsed.etag }),
		pathname: parsed.pathname,
	};
}

async function readDeletionRecord(
	pathname: string,
): Promise<DeletionRecord | null> {
	try {
		return parseDeletionRecord(
			await readFile(cleanupRecordPath(pathname), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

async function writeDeletionRecord(record: DeletionRecord): Promise<void> {
	const targetPath = cleanupRecordPath(record.pathname);
	let stagedPath: string | undefined;

	try {
		stagedPath = await stageContents(
			targetPath,
			JSON.stringify(record, null, 2),
		);
		await publishStagedFile(stagedPath, targetPath);
		stagedPath = undefined;
	} finally {
		await removeStagedFile(stagedPath);
	}
}

async function withPathnameLock<Result>(
	pathname: string,
	action: () => Promise<Result>,
): Promise<Result> {
	const previous = pathnameLocks.get(pathname) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pathnameLocks.set(pathname, queued);

	await previous;

	try {
		return await action();
	} finally {
		release();

		if (pathnameLocks.get(pathname) === queued) {
			pathnameLocks.delete(pathname);
		}
	}
}

function storagePathKey(storagePath: string): string {
	const absolutePath = resolve(storagePath);
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

async function fileIdentityKey(storagePath: string): Promise<string | null> {
	try {
		const file = await stat(storagePath, { bigint: true });
		return `file:${file.dev}:${file.ino}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

async function liveDataPaths(
	records: Iterable<StoredMetadataRecord>,
): Promise<Set<string>> {
	const livePaths = new Set<string>();

	for (const { metadata } of [...records]) {
		const dataPath = resolveStoredDataPath(
			metadata.pathname,
			metadata.dataFile,
		);
		livePaths.add(storagePathKey(dataPath));

		if (metadata.dataFile !== undefined) {
			continue;
		}

		const identity = await fileIdentityKey(dataPath);

		if (identity) {
			livePaths.add(identity);
		}
	}

	return livePaths;
}

async function isLiveDataPath(
	dataPath: string,
	dataFile: string,
	livePaths: Set<string>,
): Promise<boolean> {
	if (livePaths.has(storagePathKey(dataPath))) {
		return true;
	}

	if (dataFile !== "") {
		return false;
	}

	const identity = await fileIdentityKey(dataPath);
	return identity !== null && livePaths.has(identity);
}

async function scanDeletionRecords(livePaths: Set<string>): Promise<{
	complete: boolean;
	records: DeletionRecord[];
}> {
	let entries: import("node:fs").Dirent<string>[];

	try {
		entries = await readdir(cleanupRoot(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { complete: true, records: [] };
		}

		throw error;
	}

	let complete = true;
	const records: DeletionRecord[] = [];

	for (const entry of entries) {
		if (!CLEANUP_RECORD_FILENAME.test(entry.name)) {
			continue;
		}

		if (
			await isLiveDataPath(
				join(cleanupRoot(), entry.name),
				"",
				livePaths,
			)
		) {
			continue;
		}

		try {
			if (!entry.isFile()) {
				throw new BlobError("Stored blob cleanup record is not a file");
			}

			const record = parseDeletionRecord(
				await readFile(join(cleanupRoot(), entry.name), "utf8"),
			);

			if (basename(cleanupRecordPath(record.pathname)) !== entry.name) {
				throw new BlobError(
					"Stored blob cleanup record filename does not match pathname",
				);
			}

			records.push(record);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}

			complete = false;
			console.warn(
				`[vercel-blob-local] Skipping invalid cleanup record ${entry.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return { complete, records };
}

async function reconcileDeletionRecordUnlocked(
	pathname: string,
	livePaths: Set<string>,
): Promise<void> {
	const current = await readDeletionRecord(pathname);

	if (!current) {
		return;
	}

	const failures: string[] = [];

	for (const dataFile of current.dataFiles) {
		const dataPath = resolveStoredDataPath(
			current.pathname,
			dataFile || undefined,
		);

		if (await isLiveDataPath(dataPath, dataFile, livePaths)) {
			continue;
		}

		try {
			await removeDataFile(dataPath);
		} catch (error) {
			failures.push(dataFile);
			logCleanupFailure(dataPath, error);
		}
	}

	if (failures.length === 0) {
		await rm(cleanupRecordPath(current.pathname), { force: true });
		return;
	}

	await writeDeletionRecord({
		dataFiles: failures,
		...(current.etag ? { etag: current.etag } : {}),
		pathname: current.pathname,
	});
}

async function reconcileDeletionRecord(
	record: DeletionRecord,
	livePaths: Set<string>,
): Promise<void> {
	await withPathnameLock(record.pathname, () =>
		reconcileDeletionRecordUnlocked(record.pathname, livePaths),
	);
}

async function reconcilePathnameCleanupUnlocked(
	pathname: string,
): Promise<void> {
	if (!(await readDeletionRecord(pathname))) {
		return;
	}

	const metadataScan = await getStoredMetadataScan();

	if (!metadataScan.complete) {
		console.warn(
			`[vercel-blob-local] Deferred cleanup for ${JSON.stringify(pathname)} because metadata is incomplete`,
		);
		return;
	}

	await reconcileDeletionRecordUnlocked(
		pathname,
		await liveDataPaths(metadataScan.recordsByStoragePath.values()),
	);
}

async function retireShadowedLegacyMetadata(
	records: Iterable<StoredMetadataRecord>,
): Promise<boolean> {
	let changed = false;
	const recordsByPathname = new Map<string, StoredMetadataRecord[]>();

	for (const record of records) {
		const pathnameRecords = recordsByPathname.get(record.metadata.pathname) ?? [];
		pathnameRecords.push(record);
		recordsByPathname.set(record.metadata.pathname, pathnameRecords);
	}

	for (const [pathname, pathnameRecords] of recordsByPathname) {
		try {
			if (normalizePathname(pathname) !== pathname) {
				continue;
			}
		} catch {
			continue;
		}

		const current = pathnameRecords.find(
			(record) =>
				storagePathKey(record.storagePath) === storagePathKey(metadataPath(pathname)),
		);
		const legacy = pathnameRecords.find(
			(record) =>
				storagePathKey(record.storagePath) ===
				storagePathKey(join(metadataRoot(), basename(legacyMetadataPath(pathname)))),
		);

		if (!current || !legacy || current.storagePath === legacy.storagePath) {
			continue;
		}

		const currentDataPath = resolveStoredDataPath(
			pathname,
			current.metadata.dataFile,
		);

		try {
			if (!(await stat(currentDataPath)).isFile()) {
				throw new Error("current payload is not a regular file");
			}
		} catch (error) {
			console.warn(
				`[vercel-blob-local] Preserving legacy metadata for ${JSON.stringify(pathname)} because the current payload is unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			continue;
		}

		const legacyDataFile = legacy.metadata.dataFile ?? "";
		const legacyDataPath = resolveStoredDataPath(
			pathname,
			legacyDataFile || undefined,
		);

		if (storagePathKey(legacyDataPath) !== storagePathKey(currentDataPath)) {
			let pending: DeletionRecord | null;

			try {
				pending = await readDeletionRecord(pathname);
			} catch (error) {
				console.warn(
					`[vercel-blob-local] Preserving legacy metadata for ${JSON.stringify(pathname)} because its cleanup record is invalid: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}

			const legacyEtag = /^[a-f0-9]{64}$/u.test(legacy.metadata.etag)
				? legacy.metadata.etag
				: undefined;
			await writeDeletionRecord({
				dataFiles: [
					...new Set([...(pending?.dataFiles ?? []), legacyDataFile]),
				],
				...(pending?.etag
					? { etag: pending.etag }
					: legacyEtag
						? { etag: legacyEtag }
						: {}),
				pathname,
			});
		}

		await rm(legacy.storagePath, { force: true });
		changed = true;
	}

	return changed;
}

async function removeStaleStagedFiles(
	directory: string,
	livePaths: Set<string>,
): Promise<void> {
	let entries: import("node:fs").Dirent<string>[];

	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}

		throw error;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !STAGED_FILENAME.test(entry.name)) {
			continue;
		}

		const stagedPath = join(directory, entry.name);

		if (await isLiveDataPath(stagedPath, "", livePaths)) {
			continue;
		}

		await removeStagedFile(stagedPath);
	}
}

async function removeAllStaleStagedFiles(
	livePaths: Set<string>,
): Promise<void> {
	await Promise.all(
		[dataRoot(), metadataRoot(), cleanupRoot()].map((directory) =>
			removeStaleStagedFiles(directory, livePaths),
		),
	);

	let multipartEntries: import("node:fs").Dirent<string>[];

	try {
		multipartEntries = await readdir(multipartStorageRoot(), {
			withFileTypes: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}

		throw error;
	}

	await Promise.all(
		multipartEntries
			.filter(
				(entry) => entry.isDirectory() && /^[a-f0-9]{32}$/u.test(entry.name),
			)
			.map((entry) =>
				removeStaleStagedFiles(
					join(multipartStorageRoot(), entry.name),
					livePaths,
				),
			),
	);
}

async function removeOrphanedGenerations(livePaths: Set<string>): Promise<void> {
	let entries: import("node:fs").Dirent<string>[];

	try {
		entries = await readdir(dataRoot(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}

		throw error;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !GENERATION_DATA_FILENAME.test(entry.name)) {
			continue;
		}

		const dataPath = join(dataRoot(), entry.name);

		if (await isLiveDataPath(dataPath, "", livePaths)) {
			continue;
		}

		await removeDataFile(dataPath).catch((error: unknown) => {
			logCleanupFailure(dataPath, error);
		});
	}
}

export async function reconcileStorage(): Promise<void> {
	invalidateStoredMetadataScan();
	let metadataScan = await scanStoredMetadataRecords();

	if (!metadataScan.complete) {
		console.warn(
			"[vercel-blob-local] Storage reconciliation skipped because metadata is incomplete",
		);
		return;
	}

	const retiredLegacyMetadata = await retireShadowedLegacyMetadata(
		metadataScan.recordsByStoragePath.values(),
	);

	if (retiredLegacyMetadata) {
		metadataScan = await scanStoredMetadataRecords();
	}

	if (!metadataScan.complete) {
		console.warn(
			"[vercel-blob-local] Storage reconciliation skipped because metadata changed unexpectedly",
		);
		return;
	}

	cacheStoredMetadataScan(metadataScan);
	const livePaths = await liveDataPaths(
		metadataScan.recordsByStoragePath.values(),
	);
	const cleanupScan = await scanDeletionRecords(livePaths);

	for (const record of cleanupScan.records) {
		await reconcileDeletionRecord(record, livePaths);
	}

	if (!cleanupScan.complete) {
		console.warn(
			"[vercel-blob-local] Orphan cleanup skipped because cleanup records are incomplete",
		);
		return;
	}

	await removeOrphanedGenerations(livePaths);
	await removeAllStaleStagedFiles(livePaths);
}

async function readMultipartMetadata(
	uploadId: string,
): Promise<MultipartMetadata> {
	try {
		const raw = await readFile(multipartMetadataPath(uploadId), "utf8");
		return JSON.parse(raw) as MultipartMetadata;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlobNotFoundError();
		}

		throw error;
	}
}

function parseListCursor(cursor?: string): string | undefined {
	if (cursor === undefined) {
		return undefined;
	}

	const match = /^v1[.]([A-Za-z0-9_-]+)$/u.exec(cursor);

	if (!match?.[1]) {
		throw new BlobError("cursor is invalid");
	}

	const encodedPathname = match[1];
	const pathname = Buffer.from(encodedPathname, "base64url").toString("utf8");

	if (
		!pathname.isWellFormed() ||
		Buffer.from(pathname, "utf8").toString("base64url") !== encodedPathname
	) {
		throw new BlobError("cursor is invalid");
	}

	return pathname;
}

function buildListCursor(pathname: string): string {
	return `v1.${Buffer.from(pathname, "utf8").toString("base64url")}`;
}

function parseListLimit(limit?: number): number {
	if (limit === undefined) {
		return 1000;
	}

	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new BlobError("limit must be a positive integer");
	}

	return limit;
}

export async function put(
	pathnameInput: string,
	body: PutBody,
	options: PutCommandOptions,
): Promise<PutBlobResult> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(
		options.addRandomSuffix ? addRandomSuffix(pathnameInput) : pathnameInput,
	);
	const generationDataPath = resolveStoredDataPath(
		pathname,
		`.vercel-blob-local-data-${randomBytes(16).toString("hex")}.blob`,
	);
	const staged = await stageBody(generationDataPath, body, options);
	let stagedDataPath: string | undefined = staged.path;
	let stagedMetadataPath: string | undefined;
	let unpublishedGenerationPath: string | undefined;

	try {
		return await withPathnameLock(pathname, async () => {
			await assertMetadataPathWritable(pathname);
			const existing = await readStoredBlob(pathname).catch((error) => {
				if (error instanceof BlobNotFoundError) {
					return null;
				}

				throw error;
			});

			if (existing) {
				if (options.ifMatch && options.ifMatch !== existing.metadata.etag) {
					throw new BlobPreconditionFailedError();
				}

				if (!options.allowOverwrite && !options.ifMatch) {
					throw new BlobPreconditionFailedError();
				}
			} else if (options.ifMatch) {
				throw new BlobPreconditionFailedError();
			}

			await reconcilePathnameCleanupUnlocked(pathname);
			const existingRecords = await readMetadataRecords(pathname);

			const metadata = buildMetadata(
				pathname,
				{ ...staged, dataFile: basename(generationDataPath) },
				options,
			);
			const currentMetadataPath = metadataPath(pathname);
			stagedMetadataPath = await stageContents(
				currentMetadataPath,
				JSON.stringify(metadata, null, 2),
			);
			const obsoleteDataFiles = new Set(
				existingRecords
					.filter(
						({ metadata: existingMetadata }) =>
							storagePathKey(
								resolveStoredDataPath(
									pathname,
									existingMetadata.dataFile,
								),
							) !== storagePathKey(generationDataPath),
					)
					.map(({ metadata: existingMetadata }) =>
						existingMetadata.dataFile ?? "",
					),
			);

			if (obsoleteDataFiles.size > 0) {
				const pending = await readDeletionRecord(pathname);
				const existingEtag = existingRecords.find(({ metadata: candidate }) =>
					/^[a-f0-9]{64}$/u.test(candidate.etag),
				)?.metadata.etag;

				await writeDeletionRecord({
					dataFiles: [
						...new Set([
							...(pending?.dataFiles ?? []),
							...obsoleteDataFiles,
						]),
					],
					...(existingEtag
						? { etag: existingEtag }
						: pending?.etag
							? { etag: pending.etag }
							: {}),
					pathname,
				});
			}

			await publishStagedFile(stagedDataPath as string, generationDataPath);
			stagedDataPath = undefined;
			unpublishedGenerationPath = generationDataPath;
			await publishStagedFile(stagedMetadataPath, currentMetadataPath);
			stagedMetadataPath = undefined;
			unpublishedGenerationPath = undefined;

			const legacyPathKey = storagePathKey(legacyMetadataPath(pathname));
			const remainingLegacyRecords: StoredMetadataRecord[] = [];

			for (const record of existingRecords.filter(
				(candidate) => storagePathKey(candidate.storagePath) === legacyPathKey,
			)) {
				try {
					await rm(record.storagePath, { force: true });
				} catch (error) {
					remainingLegacyRecords.push(record);
					console.warn(
						`[vercel-blob-local] Unable to remove legacy metadata for ${pathname}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}

			await replaceStoredMetadataRecords(pathname, [
				{ metadata, storagePath: currentMetadataPath },
				...remainingLegacyRecords,
			]);

			if (obsoleteDataFiles.size > 0) {
				await reconcilePathnameCleanupUnlocked(pathname).catch(
					(recordError: unknown) => {
						logCleanupFailure(cleanupRecordPath(pathname), recordError);
					},
				);
			}

			return metadataToPutResult(metadata);
		});
	} finally {
		await Promise.all([
			removeStagedFile(stagedDataPath),
			removeStagedFile(stagedMetadataPath),
			removeStagedFile(unpublishedGenerationPath),
		]);
	}
}

async function readStoredBlob(pathname: string): Promise<{
	dataPath: string;
	metadata: StoredMetadata;
}> {
	const metadata = await readMetadata(pathname);
	const dataPath = resolveStoredDataPath(pathname, metadata.dataFile);

	await stat(dataPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlobNotFoundError();
		}

		throw error;
	});

	return { dataPath, metadata };
}

export async function head(
	urlOrPathname: string,
	options?: BlobCommandOptions,
): Promise<HeadBlobResult> {
	await assertNotAborted(options?.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(urlOrPathname);

	return withPathnameLock(pathname, async () => {
		const { metadata } = await readStoredBlob(pathname);
		return metadataToHeadResult(metadata);
	});
}

export async function get(
	urlOrPathname: string,
	options: GetCommandOptions,
): Promise<GetBlobResult | null> {
	await assertNotAborted(options.abortSignal);
	const pathname = normalizePathname(urlOrPathname);

	return withPathnameLock(pathname, async () => {
		const resolved = await resolveDirectBlob(pathname, options);

		if (!resolved) {
			return null;
		}

		const { blob, dataPath, headers, statusCode } = resolved;

		if (statusCode === 304) {
			return {
				blob: {
					cacheControl: blob.cacheControl,
					contentDisposition: blob.contentDisposition,
					contentType: null,
					downloadUrl: blob.downloadUrl,
					etag: blob.etag,
					pathname: blob.pathname,
					size: null,
					uploadedAt: blob.uploadedAt,
					url: blob.url,
				},
				headers,
				statusCode: 304,
				stream: null,
			};
		}

		const file = await open(dataPath, "r");

		return {
			blob: { ...blob },
			headers,
			statusCode: 200,
			stream: Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>,
		};
	});
}

export type DirectHeadResult = {
	blob: HeadBlobResult;
	headers: Headers;
	statusCode: 200 | 304;
};

type ResolvedDirectBlob = DirectHeadResult & { dataPath: string };

async function resolveDirectBlob(
	pathname: string,
	options: GetCommandOptions,
): Promise<ResolvedDirectBlob | null> {
	let stored: Awaited<ReturnType<typeof readStoredBlob>>;

	try {
		stored = await readStoredBlob(pathname);
	} catch (error) {
		if (error instanceof BlobNotFoundError) {
			return null;
		}

		throw error;
	}

	const { dataPath, metadata } = stored;

	if (metadata.access === "private") {
		assertAuthorized(options);
	}

	const blob = metadataToHeadResult(metadata);
	const headers = new Headers({
		"cache-control": metadata.cacheControl,
		"content-disposition": buildContentDisposition(metadata.pathname),
		etag: metadata.etag,
	});

	if (options.ifNoneMatch === metadata.etag) {
		return { blob, dataPath, headers, statusCode: 304 };
	}

	headers.set("content-length", String(metadata.size));
	headers.set("content-type", metadata.contentType);

	return { blob, dataPath, headers, statusCode: 200 };
}

export async function getDirectHead(
	urlOrPathname: string,
	options: GetCommandOptions,
): Promise<DirectHeadResult | null> {
	await assertNotAborted(options.abortSignal);

	const pathname = normalizePathname(urlOrPathname);

	return withPathnameLock(pathname, async () => {
		const resolved = await resolveDirectBlob(pathname, options);

		if (!resolved) {
			return null;
		}

		const { blob, headers, statusCode } = resolved;
		return { blob, headers, statusCode };
	});
}

export async function del(
	urlOrPathname: string[] | string,
	options?: DeleteCommandOptions,
): Promise<void> {
	await assertNotAborted(options?.abortSignal);
	assertAuthorized(options);

	const inputs = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];

	if (inputs.length > 1 && options?.ifMatch) {
		throw new BlobError("ifMatch can only be used when deleting one blob");
	}

	for (const input of inputs) {
		const pathname = normalizePathname(input);

		await withPathnameLock(pathname, async () => {
			const pending = await readDeletionRecord(pathname);
			const legacyMetadata = await readLegacyMetadata(pathname);
			let metadataRecord: Awaited<ReturnType<typeof readMetadataRecord>> | null =
				null;
			let metadata: StoredMetadata | null = null;

			try {
				metadataRecord = await readMetadataRecord(pathname);
				metadata = metadataRecord.metadata;
			} catch (error) {
				if (!(error instanceof BlobNotFoundError)) {
					throw error;
				}
			}

			if (options?.ifMatch) {
				if (!metadata && pending?.etag !== options.ifMatch) {
					throw new BlobNotFoundError();
				}

				if (metadata && metadata.etag !== options.ifMatch) {
					throw new BlobPreconditionFailedError();
				}
			}

			const dataFiles = new Set(pending?.dataFiles ?? []);

			if (metadata) {
				dataFiles.add(metadata.dataFile ?? "");
			}

			if (legacyMetadata) {
				dataFiles.add(legacyMetadata.dataFile ?? "");
			}

			if (dataFiles.size === 0) {
				return;
			}

			const record: DeletionRecord = {
				dataFiles: [...dataFiles],
				...(metadata?.etag
					? { etag: metadata.etag }
					: pending?.etag
						? { etag: pending.etag }
						: {}),
				pathname,
			};
			await writeDeletionRecord(record);

			if (legacyMetadata) {
				await removeLegacyMetadata(pathname);
			}

			if (metadataRecord) {
				await rm(metadataRecord.storagePath, { force: true });
				await replaceStoredMetadataRecords(pathname, []);
			}

			await reconcilePathnameCleanupUnlocked(pathname).catch(
				(recordError: unknown) => {
					logCleanupFailure(cleanupRecordPath(pathname), recordError);
				},
			);
		});
	}
}

export async function list<
	Mode extends "expanded" | "folded" | undefined = undefined,
>(options?: ListCommandOptions<Mode>): Promise<ListCommandResult<Mode>> {
	await assertNotAborted(options?.abortSignal);
	assertAuthorized(options);

	const limit = parseListLimit(options?.limit);
	const cursorPathname = parseListCursor(options?.cursor);
	const prefix = options?.prefix ?? "";
	const readableRecords = (await listMetadataRecords())
		.filter(({ metadata }) => metadata.pathname.startsWith(prefix))
		.map(({ metadata }) => ({ metadata, pathname: metadata.pathname }));
	type ListedEntry =
		| {
				kind: "blob";
				metadata: StoredMetadata;
				pathname: string;
			}
		| { kind: "folder"; pathname: string };
	let listedEntries: ListedEntry[];

	if (options?.mode === "folded") {
		const entriesByPathname = new Map<string, ListedEntry>();

		for (const record of readableRecords) {
			const relativePathname = record.pathname.slice(prefix.length);
			const slashIndex = relativePathname.indexOf("/");

			if (slashIndex === -1) {
				entriesByPathname.set(record.pathname, { kind: "blob", ...record });
				continue;
			}

			const folderPathname = `${prefix}${relativePathname.slice(0, slashIndex + 1)}`;
			entriesByPathname.set(folderPathname, {
				kind: "folder",
				pathname: folderPathname,
			});
		}

		listedEntries = [...entriesByPathname.values()];
	} else {
		listedEntries = readableRecords.map((record) => ({
			kind: "blob",
			...record,
		}));
	}

	listedEntries.sort((left, right) =>
		comparePathnames(left.pathname, right.pathname),
	);
	const start =
		cursorPathname === undefined
			? 0
			: listedEntries.findIndex(
					({ pathname }) => comparePathnames(pathname, cursorPathname) > 0,
				);
	const normalizedStart = start === -1 ? listedEntries.length : start;
	const selected = listedEntries.slice(normalizedStart, normalizedStart + limit);
	const blobs = selected.flatMap((entry) =>
		entry.kind === "folder"
			? []
			: [
					{
						downloadUrl: getDownloadUrl(entry.pathname),
						etag: entry.metadata.etag,
						pathname: entry.pathname,
						size: entry.metadata.size,
						uploadedAt: new Date(entry.metadata.uploadedAt),
						url: buildUrl(entry.pathname),
					},
				],
	);
	const nextIndex = normalizedStart + selected.length;
	const hasMore = nextIndex < listedEntries.length;
	const lastSelectedPathname = selected.at(-1)?.pathname;
	const result: ListBlobResult = {
		blobs,
		hasMore,
		...(hasMore && lastSelectedPathname
			? { cursor: buildListCursor(lastSelectedPathname) }
			: {}),
	};

	if (options?.mode !== "folded") {
		return result as ListCommandResult<Mode>;
	}

	const folders = selected.flatMap((entry) =>
		entry.kind === "folder" ? [entry.pathname] : [],
	);

	return { ...result, folders } as ListCommandResult<Mode>;
}

export async function copy(
	fromUrlOrPathname: string,
	toPathname: string,
	options: CopyCommandOptions,
): Promise<CopyBlobResult> {
	return (await copyWithSourceEtag(fromUrlOrPathname, toPathname, options)).result;
}

async function copyWithSourceEtag(
	fromUrlOrPathname: string,
	toPathname: string,
	options: CopyCommandOptions,
): Promise<{ result: CopyBlobResult; sourceEtag: string }> {
	assertAuthorized(options);
	const getOptions: GetCommandOptions = { access: options.access };

	if (options.token) {
		getOptions.token = options.token;
	}

	const source = await get(fromUrlOrPathname, getOptions);

	if (!source || source.statusCode !== 200 || !source.stream) {
		throw new BlobNotFoundError();
	}

	if (options.ifMatch && options.ifMatch !== source.blob.etag) {
		await source.stream.cancel();
		throw new BlobPreconditionFailedError();
	}

	const { ifMatch: _sourceIfMatch, ...destinationOptions } = options;

	try {
		return {
			result: await put(toPathname, source.stream, destinationOptions),
			sourceEtag: source.blob.etag,
		};
	} catch (error) {
		await source.stream.cancel().catch(() => undefined);
		throw error;
	}
}

export async function rename(
	fromUrlOrPathname: string,
	toPathname: string,
	options: RenameCommandOptions,
): Promise<RenameBlobResult> {
	if (
		!options.addRandomSuffix &&
		normalizePathname(fromUrlOrPathname) === normalizePathname(toPathname)
	) {
		throw new BlobPathnameMismatchError(
			"Rename source and destination pathnames must differ",
		);
	}

	const { result, sourceEtag } = await copyWithSourceEtag(
		fromUrlOrPathname,
		toPathname,
		options,
	);
	const deleteOptions: DeleteCommandOptions = { ifMatch: sourceEtag };

	if (options.abortSignal) {
		deleteOptions.abortSignal = options.abortSignal;
	}

	if (options.token) {
		deleteOptions.token = options.token;
	}

	await del(fromUrlOrPathname, deleteOptions);
	return result;
}

export async function createFolder(
	pathnameInput: string,
	options: CreateFolderCommandOptions = {},
): Promise<CreateFolderResult> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(`${pathnameInput.replace(/\/+$/u, "")}/`);
	const result = await put(pathname, Buffer.alloc(0), {
		access: options.access ?? "public",
		allowOverwrite: true,
		contentType: "application/x-directory",
		...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
		...(options.token ? { token: options.token } : {}),
	});

	return {
		pathname: result.pathname,
		url: result.url,
	};
}

export async function createMultipartUpload(
	pathnameInput: string,
	options: CommonCreateBlobOptions,
): Promise<{
	key: string;
	uploadId: string;
}> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(
		options.addRandomSuffix ? addRandomSuffix(pathnameInput) : pathnameInput,
	);
	const uploadId = randomBytes(16).toString("hex");
	const key = pathname;
	const multipartMetadata: MultipartMetadata = {
		access: options.access,
		key,
		pathname,
		uploadId,
		...(options.cacheControlMaxAge === undefined
			? {}
			: { cacheControlMaxAge: options.cacheControlMaxAge }),
		...(options.contentType === undefined
			? {}
			: { contentType: options.contentType }),
		...(options.maximumSizeInBytes === undefined
			? {}
			: { maximumSizeInBytes: options.maximumSizeInBytes }),
	};

	await mkdir(multipartRoot(uploadId), { recursive: true });
	await writeFile(
		multipartMetadataPath(uploadId),
		JSON.stringify(multipartMetadata, null, 2),
	);

	return { key, uploadId };
}

export async function uploadPart(
	pathnameInput: string,
	body: PutBody,
	options: UploadPartCommandOptions,
): Promise<Part> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(pathnameInput);
	const metadata = await readMultipartMetadata(options.uploadId);

	if (metadata.key !== options.key || metadata.pathname !== pathname) {
		throw new BlobPathnameMismatchError(
			"Multipart upload key or pathname does not match",
		);
	}

	const partPath = multipartPartPath(options.uploadId, options.partNumber);
	const staged = await stageBody(partPath, body, options);

	try {
		await publishStagedFile(staged.path, partPath);
	} catch (error) {
		await removeStagedFile(staged.path);
		throw error;
	}

	return {
		etag: staged.etag,
		partNumber: options.partNumber,
	};
}

export async function completeMultipartUpload(
	pathnameInput: string,
	parts: Part[],
	options: CompleteMultipartUploadCommandOptions,
): Promise<PutBlobResult> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	if (!Array.isArray(parts) || parts.length === 0) {
		throw new BlobError("Multipart parts must be a non-empty array");
	}

	for (const part of parts) {
		if (
			typeof part !== "object" ||
			part === null ||
			!Number.isSafeInteger(part.partNumber) ||
			typeof part.etag !== "string" ||
			!/^[a-f0-9]{64}$/u.test(part.etag)
		) {
			throw new BlobError(
				"Multipart parts must be consecutive positive integers with SHA-256 ETags",
			);
		}
	}

	const sortedParts = [...parts].sort(
		(left, right) => left.partNumber - right.partNumber,
	);

	for (const [index, part] of sortedParts.entries()) {
		if (part.partNumber !== index + 1) {
			throw new BlobError(
				"Multipart parts must be consecutive positive integers with SHA-256 ETags",
			);
		}
	}

	const pathname = normalizePathname(pathnameInput);
	const metadata = await readMultipartMetadata(options.uploadId);

	if (metadata.key !== options.key || metadata.pathname !== pathname) {
		throw new BlobPathnameMismatchError(
			"Multipart upload key or pathname does not match",
		);
	}

	async function* verifiedParts(): AsyncGenerator<Buffer> {
		for (const part of sortedParts) {
			const hash = createHash("sha256");
			const stream = createReadStream(
				multipartPartPath(options.uploadId, part.partNumber),
			);

			for await (const value of stream) {
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				hash.update(chunk);
				yield chunk;
			}

			if (hash.digest("hex") !== part.etag) {
				throw new BlobPreconditionFailedError();
			}
		}
	}
	const putOptions: PutCommandOptions = {
		access: metadata.access,
	};

	if (options.abortSignal) {
		putOptions.abortSignal = options.abortSignal;
	}

	if (options.allowOverwrite !== undefined) {
		putOptions.allowOverwrite = options.allowOverwrite;
	}

	if (metadata.cacheControlMaxAge !== undefined) {
		putOptions.cacheControlMaxAge = metadata.cacheControlMaxAge;
	}

	if (metadata.maximumSizeInBytes !== undefined) {
		putOptions.maximumSizeInBytes = metadata.maximumSizeInBytes;
	}

	if (options.token) {
		putOptions.token = options.token;
	}

	const contentType = metadata.contentType ?? options.contentType;

	if (contentType !== undefined) {
		putOptions.contentType = contentType;
	}

	if (options.ifMatch !== undefined) {
		putOptions.ifMatch = options.ifMatch;
	}

	const result = await put(pathname, Readable.from(verifiedParts()), putOptions);

	await rm(multipartRoot(options.uploadId), { force: true, recursive: true });

	return result;
}

export async function createMultipartUploader(
	pathname: string,
	options: CommonCreateBlobOptions,
): Promise<{
	complete(parts: Part[]): Promise<PutBlobResult>;
	key: string;
	uploadId: string;
	uploadPart(partNumber: number, body: PutBody): Promise<Part>;
}> {
	const upload = await createMultipartUpload(pathname, options);

	return {
		...upload,
		complete(parts) {
			return completeMultipartUpload(pathname, parts, {
				...options,
				key: upload.key,
				uploadId: upload.uploadId,
			});
		},
		uploadPart(partNumber, body) {
			return uploadPart(pathname, body, {
				...options,
				key: upload.key,
				partNumber,
				uploadId: upload.uploadId,
			});
		},
	};
}
