import { createHash, randomBytes } from "node:crypto";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { assertNotAborted } from "./blob-constraints.js";
import {
	BlobError,
	BlobFileTooLargeError,
	BlobRequestAbortedError,
} from "./errors.js";
import type { OnUploadProgressCallback, PutBody } from "./types.js";

export type StagedFile = {
	etag: string;
	path: string;
	size: number;
};

function temporaryPath(targetPath: string): string {
	return join(
		dirname(targetPath),
		`.vercel-blob-local-${randomBytes(12).toString("hex")}.tmp`,
	);
}

function bodyToReadable(body: PutBody): Readable {
	if (Buffer.isBuffer(body) || typeof body === "string") {
		return Readable.from([body]);
	}

	if (body instanceof ArrayBuffer) {
		return Readable.from([Buffer.from(body)]);
	}

	if (body instanceof Blob) {
		return Readable.fromWeb(
			body.stream() as import("node:stream/web").ReadableStream<Uint8Array>,
		);
	}

	if (body instanceof ReadableStream) {
		return Readable.fromWeb(
			body as import("node:stream/web").ReadableStream<Uint8Array>,
		);
	}

	if (body instanceof Readable) {
		return body;
	}

	if (Symbol.asyncIterator in Object(body)) {
		return Readable.from(body as AsyncIterable<Buffer | string | Uint8Array>);
	}

	throw new BlobError("Unsupported blob body");
}

async function writeAll(
	file: Awaited<ReturnType<typeof open>>,
	chunk: Buffer,
): Promise<void> {
	let offset = 0;

	while (offset < chunk.length) {
		const { bytesWritten } = await file.write(
			chunk,
			offset,
			chunk.length - offset,
			null,
		);

		if (bytesWritten === 0) {
			throw new BlobError("Unable to write blob data");
		}

		offset += bytesWritten;
	}
}

export async function stageBody(
	targetPath: string,
	body: PutBody,
	options: {
		abortSignal?: AbortSignal;
		maximumSizeInBytes?: number;
		onUploadProgress?: OnUploadProgressCallback;
	} = {},
): Promise<StagedFile> {
	await assertNotAborted(options.abortSignal);
	const source = bodyToReadable(body);
	const path = temporaryPath(targetPath);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	let created = false;
	const hash = createHash("sha256");
	const abort = (): void => {
		source.destroy(new BlobRequestAbortedError());
	};
	let size = 0;

	try {
		await mkdir(dirname(targetPath), { recursive: true });
		file = await open(path, "wx");
		created = true;
		options.abortSignal?.addEventListener("abort", abort, { once: true });

		if (options.abortSignal?.aborted) {
			abort();
		}

		for await (const value of source) {
			await assertNotAborted(options.abortSignal);
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			size += chunk.length;

			if (
				options.maximumSizeInBytes !== undefined &&
				size > options.maximumSizeInBytes
			) {
				throw new BlobFileTooLargeError(
					`Blob is larger than the maximum size of ${options.maximumSizeInBytes} bytes`,
				);
			}

			hash.update(chunk);
			await writeAll(file, chunk);
		}

		await file.close();
		file = undefined;
		options.abortSignal?.removeEventListener("abort", abort);
		options.onUploadProgress?.({ loaded: size, percentage: 100, total: size });

		return { etag: hash.digest("hex"), path, size };
	} catch (error) {
		options.abortSignal?.removeEventListener("abort", abort);
		await file?.close().catch(() => undefined);
		if (created) {
			await removeStagedFile(path);
		}
		throw error;
	}
}

export async function stageContents(
	targetPath: string,
	contents: Buffer | string,
): Promise<string> {
	await mkdir(dirname(targetPath), { recursive: true });
	const path = temporaryPath(targetPath);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	let created = false;

	try {
		file = await open(path, "wx");
		created = true;
		await file.writeFile(contents);
		await file.close();
		file = undefined;
		return path;
	} catch (error) {
		await file?.close().catch(() => undefined);

		if (created) {
			await removeStagedFile(path);
		}

		throw error;
	}
}

export async function publishStagedFile(
	stagedPath: string,
	targetPath: string,
): Promise<void> {
	await rename(stagedPath, targetPath);
}

export async function removeStagedFile(path?: string): Promise<void> {
	if (!path) {
		return;
	}

	const retryableCodes = new Set([
		"EACCES",
		"EBUSY",
		"EMFILE",
		"ENFILE",
		"EPERM",
	]);

	for (let attempt = 0; attempt <= 3; attempt += 1) {
		try {
			await unlink(path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;

			if (code === "ENOENT") {
				return;
			}

			if (attempt < 3 && code && retryableCodes.has(code)) {
				await delay(50 * (attempt + 1));
				continue;
			}

			console.warn(
				`[vercel-blob-local] Unable to remove staged file ${path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}
	}
}
