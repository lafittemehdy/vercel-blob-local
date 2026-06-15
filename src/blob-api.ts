import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

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
	assertWithinMaximumSize,
	bodyToBuffer,
} from "./blob-constraints.js";
import {
	buildMetadata,
	listMetadataPathnames,
	metadataToHeadResult,
	metadataToPutResult,
	readMetadata,
	type StoredMetadata,
} from "./blob-metadata.js";
import {
	metadataPath,
	multipartMetadataPath,
	multipartPartPath,
	multipartRoot,
	normalizePathname,
	resolveDataPath,
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

function parseListCursor(cursor?: string): number {
	if (cursor === undefined) {
		return 0;
	}

	const parsed = Number(cursor);

	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new BlobError("cursor must be a non-negative integer");
	}

	return parsed;
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
	const dataPath = resolveDataPath(pathname);
	const existingMetadata = await head(
		pathname,
		options.token ? { token: options.token } : undefined,
	).catch((error) => {
		if (error instanceof BlobNotFoundError) {
			return null;
		}

		throw error;
	});

	if (existingMetadata) {
		if (options.ifMatch && options.ifMatch !== existingMetadata.etag) {
			throw new BlobPreconditionFailedError();
		}

		if (!options.allowOverwrite && !options.ifMatch) {
			throw new BlobPreconditionFailedError();
		}
	} else if (options.ifMatch) {
		throw new BlobPreconditionFailedError();
	}

	const buffer = await bodyToBuffer(body);
	assertWithinMaximumSize(buffer, options.maximumSizeInBytes);
	const metadata = buildMetadata(pathname, buffer, options);

	await mkdir(dirname(dataPath), { recursive: true });
	await mkdir(dirname(metadataPath(pathname)), { recursive: true });
	await writeFile(dataPath, buffer, {
		flag: existingMetadata || options.allowOverwrite ? "w" : "wx",
	}).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new BlobPreconditionFailedError();
		}

		throw error;
	});
	await writeFile(metadataPath(pathname), JSON.stringify(metadata, null, 2));

	options.onUploadProgress?.({
		loaded: buffer.length,
		percentage: 100,
		total: buffer.length,
	});

	return metadataToPutResult(metadata);
}

export async function head(
	urlOrPathname: string,
	options?: BlobCommandOptions,
): Promise<HeadBlobResult> {
	await assertNotAborted(options?.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(urlOrPathname);
	const metadata = await readMetadata(pathname);

	await stat(resolveDataPath(pathname)).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlobNotFoundError();
		}

		throw error;
	});

	return metadataToHeadResult(metadata);
}

export async function get(
	urlOrPathname: string,
	options: GetCommandOptions,
): Promise<GetBlobResult | null> {
	await assertNotAborted(options.abortSignal);

	const pathname = normalizePathname(urlOrPathname);
	let metadata: StoredMetadata;

	try {
		metadata = await readMetadata(pathname);
	} catch (error) {
		if (error instanceof BlobNotFoundError) {
			return null;
		}

		throw error;
	}

	if (metadata.access === "private") {
		assertAuthorized(options);
	}

	const headers = new Headers({
		"cache-control": metadata.cacheControl,
		"content-disposition": metadata.contentDisposition,
		etag: metadata.etag,
	});

	if (options.ifNoneMatch === metadata.etag) {
		return {
			blob: {
				cacheControl: metadata.cacheControl,
				contentDisposition: metadata.contentDisposition,
				contentType: null,
				downloadUrl: getDownloadUrl(pathname),
				etag: metadata.etag,
				pathname,
				size: null,
				uploadedAt: new Date(metadata.uploadedAt),
				url: buildUrl(pathname),
			},
			headers,
			statusCode: 304,
			stream: null,
		};
	}

	headers.set("content-length", String(metadata.size));
	headers.set("content-type", metadata.contentType);

	return {
		blob: {
			cacheControl: metadata.cacheControl,
			contentDisposition: metadata.contentDisposition,
			contentType: metadata.contentType,
			downloadUrl: getDownloadUrl(pathname),
			etag: metadata.etag,
			pathname,
			size: metadata.size,
			uploadedAt: new Date(metadata.uploadedAt),
			url: buildUrl(pathname),
		},
		headers,
		statusCode: 200,
		stream: Readable.toWeb(
			createReadStream(resolveDataPath(pathname)),
		) as ReadableStream<Uint8Array>,
	};
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

		if (options?.ifMatch) {
			const metadata = await readMetadata(pathname);

			if (metadata.etag !== options.ifMatch) {
				throw new BlobPreconditionFailedError();
			}
		}

		await rm(resolveDataPath(pathname), { force: true });
		await rm(metadataPath(pathname), { force: true });
	}
}

export async function list<
	Mode extends "expanded" | "folded" | undefined = undefined,
>(options?: ListCommandOptions<Mode>): Promise<ListCommandResult<Mode>> {
	await assertNotAborted(options?.abortSignal);
	assertAuthorized(options);

	const limit = parseListLimit(options?.limit);
	const start = parseListCursor(options?.cursor);
	const prefix = options?.prefix ?? "";
	const pathnames = (await listMetadataPathnames()).filter((pathname) =>
		pathname.startsWith(prefix),
	);
	const listedPathnames =
		options?.mode === "folded"
			? pathnames.filter((pathname) => !pathname.slice(prefix.length).includes("/"))
			: pathnames;
	const selected = listedPathnames.slice(start, start + limit);
	const blobs = await Promise.all(
		selected.map(async (pathname) => {
			const metadata = await readMetadata(pathname);
			return {
				downloadUrl: getDownloadUrl(pathname),
				etag: metadata.etag,
				pathname,
				size: metadata.size,
				uploadedAt: new Date(metadata.uploadedAt),
				url: buildUrl(pathname),
			};
		}),
	);
	const nextIndex = start + selected.length;
	const hasMore = nextIndex < listedPathnames.length;
	const result: ListBlobResult = {
		blobs,
		hasMore,
		...(hasMore ? { cursor: String(nextIndex) } : {}),
	};

	if (options?.mode !== "folded") {
		return result as ListCommandResult<Mode>;
	}

	const folders = [
		...new Set(
			pathnames
				.map((pathname) => pathname.slice(prefix.length))
				.filter((pathname) => pathname.includes("/"))
				.map((pathname) => `${prefix}${pathname.split("/")[0]}/`),
		),
	].sort((left, right) => left.localeCompare(right));

	return { ...result, folders } as ListCommandResult<Mode>;
}

export async function copy(
	fromUrlOrPathname: string,
	toPathname: string,
	options: CopyCommandOptions,
): Promise<CopyBlobResult> {
	assertAuthorized(options);
	const getOptions: GetCommandOptions = { access: options.access };

	if (options.token) {
		getOptions.token = options.token;
	}

	const source = await get(fromUrlOrPathname, getOptions);

	if (!source || source.statusCode !== 200 || !source.stream) {
		throw new BlobNotFoundError();
	}

	return put(toPathname, source.stream, options);
}

export async function createFolder(
	pathnameInput: string,
	options: CreateFolderCommandOptions = {},
): Promise<CreateFolderResult> {
	await assertNotAborted(options.abortSignal);
	assertAuthorized(options);

	const pathname = normalizePathname(`${pathnameInput.replace(/\/+$/u, "")}/`);
	const buffer = Buffer.alloc(0);
	const metadata = buildMetadata(pathname, buffer, {
		access: options.access ?? "public",
		contentType: "application/x-directory",
	});
	const dataPath = resolveDataPath(pathname);

	await mkdir(dirname(dataPath), { recursive: true });
	await mkdir(dirname(metadataPath(pathname)), { recursive: true });
	await writeFile(dataPath, buffer);
	await writeFile(metadataPath(pathname), JSON.stringify(metadata, null, 2));

	return {
		pathname: metadata.pathname,
		url: buildUrl(metadata.pathname),
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

	const buffer = await bodyToBuffer(body);
	assertWithinMaximumSize(buffer, options.maximumSizeInBytes);
	const etag = createHash("sha256").update(buffer).digest("hex");

	await writeFile(multipartPartPath(options.uploadId, options.partNumber), buffer);

	options.onUploadProgress?.({
		loaded: buffer.length,
		percentage: 100,
		total: buffer.length,
	});

	return {
		etag,
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

	const pathname = normalizePathname(pathnameInput);
	const metadata = await readMultipartMetadata(options.uploadId);

	if (metadata.key !== options.key || metadata.pathname !== pathname) {
		throw new BlobPathnameMismatchError(
			"Multipart upload key or pathname does not match",
		);
	}

	const buffers = await Promise.all(
		[...parts]
			.sort((left, right) => left.partNumber - right.partNumber)
			.map(async (part) => {
				const buffer = await readFile(
					multipartPartPath(options.uploadId, part.partNumber),
				);
				const etag = createHash("sha256").update(buffer).digest("hex");

				if (etag !== part.etag) {
					throw new BlobPreconditionFailedError();
				}

				return buffer;
			}),
	);
	const putOptions: PutCommandOptions = {
		access: metadata.access,
	};

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

	const result = await put(pathname, Buffer.concat(buffers), putOptions);

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
