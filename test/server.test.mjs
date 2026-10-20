import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename as renameFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import {
	copy,
	createFolder,
	createMultipartUploader,
	del,
	get as sdkGet,
	getDownloadUrl,
	head,
	list,
	put,
	rename,
} from "@vercel/blob";

import { createVercelBlobLocalServer } from "../dist/server.js";

const LOCAL_TOKEN = "vercel_blob_rw_local_test";

async function listenBlobServer(server) {
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});

	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);
	return `http://127.0.0.1:${address.port}`;
}

async function closeBlobServer(server) {
	server.closeIdleConnections();
	await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

async function withBlobApi(fn) {
	const root = await mkdtemp(join(tmpdir(), "vercel-blob-local-api-"));
	const previous = {
		apiUrl: process.env.VERCEL_BLOB_API_URL,
		localDir: process.env.VERCEL_BLOB_LOCAL_DIR,
		maximumBodySize: process.env.VERCEL_BLOB_LOCAL_MAX_BODY_SIZE,
		oidcToken: process.env.VERCEL_OIDC_TOKEN,
		publicUrl: process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL,
		retries: process.env.VERCEL_BLOB_RETRIES,
		storeId: process.env.BLOB_STORE_ID,
		token: process.env.BLOB_READ_WRITE_TOKEN,
	};
	let server = createVercelBlobLocalServer();

	process.env.BLOB_READ_WRITE_TOKEN = LOCAL_TOKEN;
	process.env.VERCEL_BLOB_LOCAL_DIR = root;
	process.env.VERCEL_BLOB_RETRIES = "0";
	delete process.env.BLOB_STORE_ID;
	delete process.env.VERCEL_OIDC_TOKEN;

	let baseUrl = await listenBlobServer(server);

	process.env.VERCEL_BLOB_API_URL = baseUrl;
	process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL = baseUrl;

	try {
		await fn(baseUrl, root, {
			restart: async () => {
				await closeBlobServer(server);
				server = createVercelBlobLocalServer();
				baseUrl = await listenBlobServer(server);
				process.env.VERCEL_BLOB_API_URL = baseUrl;
				process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL = baseUrl;
				return baseUrl;
			},
		});
	} finally {
		await closeBlobServer(server);

		restoreEnv("BLOB_READ_WRITE_TOKEN", previous.token);
		restoreEnv("VERCEL_BLOB_API_URL", previous.apiUrl);
		restoreEnv("VERCEL_BLOB_LOCAL_DIR", previous.localDir);
		restoreEnv(
			"VERCEL_BLOB_LOCAL_MAX_BODY_SIZE",
			previous.maximumBodySize,
		);
		restoreEnv("VERCEL_BLOB_LOCAL_PUBLIC_URL", previous.publicUrl);
		restoreEnv("VERCEL_BLOB_RETRIES", previous.retries);
		restoreEnv("VERCEL_OIDC_TOKEN", previous.oidcToken);
		restoreEnv("BLOB_STORE_ID", previous.storeId);
		await rm(root, { force: true, recursive: true });
	}
}

function restoreEnv(key, value) {
	if (value === undefined) {
		delete process.env[key];
		return;
	}

	process.env[key] = value;
}

async function readReturnedUrl(url) {
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${LOCAL_TOKEN}`,
		},
	});

	assert.equal(response.status, 200);
	return response.text();
}

async function storedDataPath(root, pathname) {
	const raw = await readFile(storedMetadataPath(root, pathname), "utf8");
	const metadata = JSON.parse(raw);
	return metadata.dataFile
		? join(root, ".data", metadata.dataFile)
		: join(root, ...pathname.split("/"));
}

function storedMetadataPath(root, pathname) {
	const key = createHash("sha256").update(pathname).digest("hex");
	return join(root, ".metadata", `v2-${key}.json`);
}

function legacyStoredMetadataPath(root, pathname) {
	return join(
		root,
		".metadata",
		Buffer.from(pathname, "utf8").toString("base64url"),
	);
}

function storedCleanupPath(root, pathname) {
	const key = createHash("sha256").update(pathname).digest("hex");
	return join(root, ".cleanup", `v2-${key}.json`);
}

async function putWithHost(baseUrl, host, pathname, body, delayEndMs = 0) {
	const url = new URL("/", baseUrl);
	url.searchParams.set("pathname", pathname);
	const payload = Buffer.from(body);

	return new Promise((resolve, reject) => {
		const request = httpRequest(
			url,
			{
				headers: {
					authorization: `Bearer ${LOCAL_TOKEN}`,
					"content-length": payload.length,
					host,
					"x-add-random-suffix": "false",
					"x-allow-overwrite": "true",
					"x-vercel-blob-access": "public",
				},
				method: "PUT",
			},
			(response) => {
				const chunks = [];

				response.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("error", reject);
				response.on("end", () => {
					const responseBody = Buffer.concat(chunks).toString("utf8");

					if (response.statusCode !== 200) {
						reject(new Error(responseBody));
						return;
					}

					resolve(JSON.parse(responseBody));
				});
			},
		);

		request.on("error", reject);
		request.write(payload);
		setTimeout(() => request.end(), delayEndMs);
	});
}

function readHttpResponse(response) {
	return new Promise((resolve, reject) => {
		const chunks = [];

		response.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		response.on("error", reject);
		response.on("end", () => {
			resolve({
				body: Buffer.concat(chunks).toString("utf8"),
				statusCode: response.statusCode,
			});
		});
	});
}

function beginRawPut(baseUrl, pathname, contentLength, token = LOCAL_TOKEN) {
	const url = new URL("/", baseUrl);
	url.searchParams.set("pathname", pathname);
	let request;
	const response = new Promise((resolve, reject) => {
		request = httpRequest(
			url,
			{
				headers: {
					authorization: `Bearer ${token}`,
					...(contentLength === undefined
						? {}
						: { "content-length": contentLength }),
					"x-add-random-suffix": "false",
					"x-allow-overwrite": "true",
					"x-vercel-blob-access": "private",
				},
				method: "PUT",
			},
			async (incoming) => {
				try {
					resolve(await readHttpResponse(incoming));
				} catch (error) {
					reject(error);
				}
			},
		);
		request.on("error", reject);
	});

	return { request, response };
}

test("@vercel/blob 2.8.2 covers every claimed SDK operation", async () => {
	await withBlobApi(async (baseUrl) => {
		const created = await put("api/a.txt", "hello", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
		});

		assert.equal(created.pathname, "api/a.txt");
		assert.equal(created.url, `${baseUrl}/api/a.txt`);
		assert.equal((await fetch(created.url)).status, 403);

		const metadata = await head("api/a.txt");
		assert.equal(metadata.contentType, "text/plain");
		assert.equal(metadata.size, 5);
		assert.equal(await readReturnedUrl(metadata.url), "hello");

		const publicBlob = await put("api/public.txt", "public", {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
		});
		const publicResponse = await fetch(publicBlob.url);
		assert.equal(publicResponse.status, 200);
		const publicEtag = publicResponse.headers.get("etag");
		assert.equal(await publicResponse.text(), "public");

		const publicHeadResponse = await fetch(publicBlob.url, { method: "HEAD" });
		assert.equal(publicHeadResponse.status, 200);
		assert.equal(publicHeadResponse.headers.get("content-length"), "6");
		assert.equal(
			publicHeadResponse.headers.get("content-disposition"),
			'inline; filename="public.txt"',
		);

		assert.ok(publicEtag);
		const unchangedResponse = await fetch(publicBlob.url, {
			headers: {
				"if-none-match": publicEtag,
			},
		});
		assert.equal(unchangedResponse.status, 304);

		const downloadResponse = await fetch(getDownloadUrl(publicBlob.url));
		assert.equal(downloadResponse.status, 200);
		assert.equal(
			downloadResponse.headers.get("content-disposition"),
			'attachment; filename="public.txt"',
		);
		assert.equal(await downloadResponse.text(), "public");

		const sdkPublic = await sdkGet(publicBlob.url, { access: "public" });
		assert.equal(sdkPublic.statusCode, 200);
		assert.equal(await new Response(sdkPublic.stream).text(), "public");
		const sdkPrivate = await sdkGet(created.url, { access: "private", useCache: false });
		assert.equal(sdkPrivate.statusCode, 200);
		assert.equal(await new Response(sdkPrivate.stream).text(), "hello");
		const sdkUnchanged = await sdkGet(publicBlob.url, {
			access: "public",
			ifNoneMatch: publicEtag,
		});
		assert.equal(sdkUnchanged.statusCode, 304);
		assert.equal(sdkUnchanged.stream, null);
		assert.equal(await sdkGet(`${baseUrl}/api/missing.txt`, { access: "public" }), null);

		const copied = await copy("api/a.txt", "api/b.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
			ifMatch: metadata.etag,
		});

		assert.equal(await readReturnedUrl(copied.url), "hello");

		const renamed = await rename("api/b.txt", "api/renamed.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
			ifMatch: copied.etag,
		});

		assert.equal(renamed.pathname, "api/renamed.txt");
		assert.equal(await readReturnedUrl(renamed.url), "hello");
		await assert.rejects(() => head("api/b.txt"), { name: "Error" });

		const multipart = await createMultipartUploader("api/multipart.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
		});
		const parts = [
			await multipart.uploadPart(1, "multi "),
			await multipart.uploadPart(2, "part"),
		];
		const completed = await multipart.complete(parts);

		assert.equal(await readReturnedUrl(completed.url), "multi part");

		const folder = await createFolder("api/folder", { access: "private" });
		assert.equal(folder.pathname, "api/folder/");
		assert.equal((await head(folder.pathname)).contentType, "application/x-directory");

		const listed = await list({ prefix: "api/" });
		assert.deepEqual(
			listed.blobs.map((blob) => blob.pathname).sort(),
			[
				"api/a.txt",
				"api/folder/",
				"api/multipart.txt",
				"api/public.txt",
				"api/renamed.txt",
			],
		);

		await del([
			"api/a.txt",
			"api/folder/",
			"api/multipart.txt",
			"api/public.txt",
			"api/renamed.txt",
		]);
		await assert.rejects(() => head("api/a.txt"), {
			name: "Error",
		});
	});
});

test("private blobs never advertise public caching, including legacy metadata", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const blob = await put("cache/private.txt", "secret", { access: "private" });
		const storagePath = storedMetadataPath(root, blob.pathname);
		const metadata = JSON.parse(await readFile(storagePath, "utf8"));
		assert.equal(metadata.cacheControl, "private, max-age=2592000");

		metadata.cacheControl = "public, max-age=120";
		await writeFile(storagePath, JSON.stringify(metadata));
		await restart();
		const current = await head(blob.pathname);
		assert.equal(current.cacheControl, "private, max-age=120");
		for (const method of ["GET", "HEAD"]) {
			for (const conditional of [false, true]) {
				const response = await fetch(current.url, {
					headers: {
						authorization: `Bearer ${LOCAL_TOKEN}`,
						...(conditional ? { "if-none-match": current.etag } : {}),
					},
					method,
				});
				assert.equal(response.status, conditional ? 304 : 200);
				assert.equal(response.headers.get("cache-control"), "private, max-age=120");
				await response.arrayBuffer();
			}
		}
	});
});

test("malformed delete requests cannot partially delete valid blobs", async () => {
	await withBlobApi(async (baseUrl) => {
		const blob = await put("delete/preserved.txt", "keep", { access: "private" });
		for (const body of [
			"{broken", "null", "{}", "42",
			JSON.stringify({ urls: [blob.pathname, null] }),
			JSON.stringify({ urls: [blob.pathname, 1] }),
			JSON.stringify({ urls: [blob.pathname, "../outside"] }),
			JSON.stringify({ urls: [blob.pathname, ".data/reserved"] }),
		]) {
			const response = await fetch(`${baseUrl}/delete`, {
				body,
				headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
				method: "POST",
			});
			assert.equal(response.status, 400, body);
			assert.equal((await response.json()).error.code, "bad_request");
			assert.equal(await readReturnedUrl(blob.url), "keep");
		}
	});
});

test("multipart random suffixes work with manual and automatic SDK uploads", async () => {
	await withBlobApi(async () => {
		const options = { access: "private", addRandomSuffix: true };
		const uploader = await createMultipartUploader("multipart/random.txt", options);
		const part = await uploader.uploadPart(1, "manual");
		const manual = await uploader.complete([part]);
		assert.match(manual.pathname, /^multipart\/random-[a-f0-9]{8}\.txt$/u);
		assert.equal(await readReturnedUrl(manual.url), "manual");

		const automatic = await put("multipart/random.txt", "automatic", {
			...options,
			multipart: true,
		});
		assert.match(automatic.pathname, /^multipart\/random-[a-f0-9]{8}\.txt$/u);
		assert.notEqual(automatic.pathname, manual.pathname);
		assert.equal(await readReturnedUrl(automatic.url), "automatic");
	});
});

test("malformed multipart JSON is rejected without losing uploaded parts", async () => {
	await withBlobApi(async (baseUrl) => {
		const pathname = "multipart/preserved.txt";
		const uploader = await createMultipartUploader(pathname, { access: "private" });
		const part = await uploader.uploadPart(1, "keep");
		const url = new URL("/mpu", baseUrl);
		url.searchParams.set("pathname", pathname);
		const response = await fetch(url, {
			body: "{broken",
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"x-mpu-action": "complete",
				"x-mpu-key": encodeURIComponent(uploader.key),
				"x-mpu-upload-id": uploader.uploadId,
			},
			method: "POST",
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error.code, "bad_request");
		assert.equal(await readReturnedUrl((await uploader.complete([part])).url), "keep");
	});
});

test("rename and copy use the source ETag and preserve source data on failure", async () => {
	await withBlobApi(async () => {
		const source = await put("rename/source.txt", "source", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const destination = await put("rename/destination.txt", "destination", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});

		await assert.rejects(
			() =>
				rename(source.pathname, destination.pathname, {
					access: "private",
					addRandomSuffix: false,
					ifMatch: source.etag,
				}),
			/precondition/iu,
		);
		assert.equal(await readReturnedUrl(source.url), "source");
		assert.equal(await readReturnedUrl(destination.url), "destination");

		await assert.rejects(
			() =>
				copy(source.pathname, "rename/bad-copy.txt", {
					access: "private",
					addRandomSuffix: false,
					allowOverwrite: true,
					ifMatch: "not-the-source-etag",
				}),
			/precondition/iu,
		);
		await assert.rejects(
			() => head("rename/bad-copy.txt"),
			/does not exist|not found/iu,
		);

		const renamed = await rename(source.pathname, "rename/random.txt", {
			access: "private",
			addRandomSuffix: true,
			ifMatch: source.etag,
		});

		assert.notEqual(renamed.pathname, "rename/random.txt");
		assert.equal(await readReturnedUrl(renamed.url), "source");
		await assert.rejects(
			() => head(source.pathname),
			/does not exist|not found/iu,
		);
	});
});

test("upload limits reject oversized replacements without publishing partial data", async () => {
	await withBlobApi(async (baseUrl) => {
		const original = await put("io/limited.txt", "old", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		process.env.VERCEL_BLOB_LOCAL_MAX_BODY_SIZE = "8";

		const url = new URL("/", baseUrl);
		url.searchParams.set("pathname", original.pathname);
		const oversized = await fetch(url, {
			body: "123456789",
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"x-add-random-suffix": "false",
				"x-allow-overwrite": "true",
				"x-vercel-blob-access": "private",
			},
			method: "PUT",
		});

		assert.equal(oversized.status, 413);
		assert.equal((await oversized.json()).error.code, "file_too_large");
		assert.equal(await readReturnedUrl(original.url), "old");

		const exactLimit = await put(original.pathname, "12345678", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		assert.equal(await readReturnedUrl(exactLimit.url), "12345678");
	});
});

test("chunked limits and authorization are enforced while bodies stream", async () => {
	await withBlobApi(async (baseUrl) => {
		process.env.VERCEL_BLOB_LOCAL_MAX_BODY_SIZE = "8";
		const chunked = beginRawPut(baseUrl, "io/chunked.txt");
		chunked.request.write("123456789");
		let limitTimer;
		const oversized = await Promise.race([
			chunked.response,
			new Promise((_, reject) => {
				limitTimer = setTimeout(
					() => reject(new Error("size limit waited for the request to end")),
					1_000,
				);
			}),
		]);
		clearTimeout(limitTimer);
		chunked.request.destroy();

		assert.equal(oversized.statusCode, 413);
		assert.equal(JSON.parse(oversized.body).error.code, "file_too_large");
		await assert.rejects(
			() => head("io/chunked.txt"),
			/does not exist|not found/iu,
		);

		const unauthorized = beginRawPut(
			baseUrl,
			"io/unauthorized.txt",
			1_000_000,
			"wrong-token",
		);
		unauthorized.request.flushHeaders();
		let authorizationTimer;
		const forbidden = await Promise.race([
			unauthorized.response,
			new Promise((_, reject) => {
				authorizationTimer = setTimeout(
					() => reject(new Error("authorization waited for the request body")),
					1_000,
				);
			}),
		]);
		clearTimeout(authorizationTimer);
		unauthorized.request.destroy();

		assert.equal(forbidden.statusCode, 403);
		assert.equal(JSON.parse(forbidden.body).error.code, "forbidden");
	});
});

test("slow overwrites publish data and metadata as one generation", async () => {
	await withBlobApi(async (baseUrl) => {
		const original = await put("io/atomic.txt", "old value", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const slow = beginRawPut(baseUrl, original.pathname, 9);
		slow.request.write("new ");
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.equal(await readReturnedUrl(original.url), "old value");
		slow.request.end("value");
		assert.equal((await slow.response).statusCode, 200);
		assert.equal(await readReturnedUrl(original.url), "new value");
		assert.equal((await head(original.pathname)).size, 9);
	});
});

test("multipart uploads stream safely and may exceed the per-request limit", async () => {
	await withBlobApi(async (baseUrl) => {
		process.env.VERCEL_BLOB_LOCAL_MAX_BODY_SIZE = "6";
		const multipart = await createMultipartUploader("io/large-multipart.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const parts = [
			await multipart.uploadPart(1, "123456"),
			await multipart.uploadPart(2, "abcdef"),
		];
		assert.match(multipart.uploadId, /^[a-f0-9]{32}$/u);
		const completionUrl = new URL("/mpu", baseUrl);
		completionUrl.searchParams.set("pathname", "io/large-multipart.txt");
		const traversal = await fetch(completionUrl, {
			body: JSON.stringify([
				{ etag: parts[0].etag, partNumber: "../../outside" },
			]),
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"x-mpu-action": "complete",
				"x-mpu-key": encodeURIComponent(multipart.key),
				"x-mpu-upload-id": multipart.uploadId,
				"x-vercel-blob-access": "private",
			},
			method: "POST",
		});

		assert.equal(traversal.status, 400);
		assert.equal((await traversal.json()).error.code, "bad_request");

		const invalidUploadId = await fetch(completionUrl, {
			body: "x",
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"x-mpu-action": "upload",
				"x-mpu-key": encodeURIComponent(multipart.key),
				"x-mpu-part-number": "1",
				"x-mpu-upload-id": "C:\\outside",
				"x-vercel-blob-access": "private",
			},
			method: "POST",
		});

		assert.equal(invalidUploadId.status, 400);
		assert.equal((await invalidUploadId.json()).error.code, "bad_request");
		const completed = await multipart.complete(parts);

		assert.equal(await readReturnedUrl(completed.url), "123456abcdef");
	});
});

test("reserved storage namespaces cannot be used as blob pathnames", async () => {
	await withBlobApi(async () => {
		const multipart = await createMultipartUploader("safe/upload.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});

		for (const pathname of [
			`.multipart/${multipart.uploadId}/victim.txt`,
			`.MULTIPART/${multipart.uploadId}/case-victim.txt`,
			".data/victim.txt",
			".metadata/victim.txt",
			".cleanup/victim.txt",
		]) {
			await assert.rejects(
				() =>
					put(pathname, "must not be stored", {
						access: "private",
						addRandomSuffix: false,
						allowOverwrite: true,
					}),
				/reserved storage namespace/iu,
			);
		}

		const part = await multipart.uploadPart(1, "safe payload");
		const completed = await multipart.complete([part]);
		assert.equal(await readReturnedUrl(completed.url), "safe payload");
	});
});

test("preserves URL-like pathnames and rejects unsafe service pathnames", async () => {
	await withBlobApi(async (baseUrl, root, { restart }) => {
		const colonPath = await put("docs:v1/file.txt", "colon path", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		assert.equal(colonPath.pathname, "docs:v1/file.txt");
		assert.equal(await readReturnedUrl(colonPath.url), "colon path");

		const quoted = await put('headers/a"b.txt', "quoted", {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const quotedHead = await fetch(quoted.url, { method: "HEAD" });
		assert.equal(quotedHead.status, 200);
		assert.equal(
			quotedHead.headers.get("content-disposition"),
			'inline; filename="a\\"b.txt"',
		);

		const unicode = await put("unicode/😀-東京.txt", "unicode", {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const unicodeResponse = await fetch(unicode.url);
		assert.equal(unicodeResponse.status, 200);
		assert.equal(await unicodeResponse.text(), "unicode");
		assert.equal(
			unicodeResponse.headers.get("content-disposition"),
			"inline; filename=\"_-__.txt\"; filename*=UTF-8''%F0%9F%98%80-%E6%9D%B1%E4%BA%AC.txt",
		);

		const unicodeMetadataPath = storedMetadataPath(root, unicode.pathname);
		const unicodeMetadata = JSON.parse(
			await readFile(unicodeMetadataPath, "utf8"),
		);
		unicodeMetadata.contentDisposition = 'inline; filename="😀-東京.txt"';
		await writeFile(unicodeMetadataPath, JSON.stringify(unicodeMetadata));
		const restartedBaseUrl = await restart();
		const legacyUnicodeHead = await head(unicode.pathname);
		assert.equal(
			legacyUnicodeHead.contentDisposition,
			unicodeResponse.headers.get("content-disposition"),
		);
		const legacyUnicodeResponse = await fetch(legacyUnicodeHead.url);
		assert.equal(legacyUnicodeResponse.status, 200);
		assert.equal(
			legacyUnicodeResponse.headers.get("content-disposition"),
			unicodeResponse.headers.get("content-disposition"),
		);

		for (const pathname of ["health", "bad\nname.txt"]) {
			await assert.rejects(
				() =>
					put(pathname, "rejected", {
						access: "private",
						addRandomSuffix: false,
						allowOverwrite: true,
					}),
				/reserved service endpoint|pathname is invalid/iu,
			);
		}

		const health = await fetch(`${restartedBaseUrl}/health`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true });
	});
});

test("metadata scans recover after storage errors are repaired", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const metadataDirectory = join(root, ".metadata");
		await writeFile(metadataDirectory, "temporarily unavailable");

		await assert.rejects(() => list());

		await rm(metadataDirectory, { force: true });
		await mkdir(metadataDirectory);
		assert.deepEqual((await list()).blobs, []);

		const stored = await put("recovery/blob.txt", "recovered", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const storedPath = storedMetadataPath(root, stored.pathname);
		const storedContents = await readFile(storedPath, "utf8");
		await rm(storedPath, { force: true });
		await mkdir(storedPath);
		await restart();
		await assert.rejects(() => head(stored.pathname));

		await rm(storedPath, { force: true, recursive: true });
		await writeFile(storedPath, storedContents);
		assert.equal((await head(stored.pathname)).size, 9);
	});
});

test("keeps case-distinct pathnames isolated on case-insensitive storage", async () => {
	await withBlobApi(async () => {
		const lower = await put("aaa", "first", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const mixed = await put("aaG", "second", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});

		assert.notEqual(lower.etag, mixed.etag);
		assert.equal(await readReturnedUrl((await head("aaa")).url), "first");
		assert.equal(await readReturnedUrl((await head("aaG")).url), "second");
		assert.deepEqual(
			new Set((await list()).blobs.map(({ pathname }) => pathname)),
			new Set(["aaa", "aaG"]),
		);

		await del("aaa");
		await assert.rejects(() => head("aaa"), /does not exist|not found/iu);
		assert.equal(await readReturnedUrl((await head("aaG")).url), "second");
		await del("aaG");
	});
});

test("direct HEAD is metadata-only and missing payloads return 404 cleanly", async () => {
	await withBlobApi(async (baseUrl, root) => {
		const created = await put("io/direct-head.txt", "payload", {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
		});

		const responses = await Promise.all(
			Array.from({ length: 24 }, () => fetch(created.url, { method: "HEAD" })),
		);
		assert.ok(responses.every((response) => response.status === 200));
		await del(created.pathname);
		assert.equal((await fetch(created.url)).status, 404);

		const missingPayload = await put("io/missing-payload.txt", "payload", {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		await rm(await storedDataPath(root, missingPayload.pathname), { force: true });

		assert.equal((await fetch(missingPayload.url)).status, 404);
		assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
	});
});

test("deleting nonexistent or reserved parent paths cannot remove child blobs", async () => {
	await withBlobApi(async () => {
		const child = await put("safe/child.txt", "still here", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});

		await del("safe");
		await assert.rejects(() => del(".metadata"), /reserved storage namespace/iu);

		assert.equal(await readReturnedUrl(child.url), "still here");
		assert.deepEqual(
			(await list({ prefix: "safe/" })).blobs.map(({ pathname }) => pathname),
			[child.pathname],
		);
	});
});

test("conditional delete retries drain durable cleanup records", async () => {
	await withBlobApi(async (_baseUrl, root) => {
		const pathname = "cleanup/retry.txt";
		const created = await put(pathname, "cleanup", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const metadataPath = storedMetadataPath(root, pathname);
		const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
		const dataPath = await storedDataPath(root, pathname);
		const cleanupRoot = join(root, ".cleanup");
		const cleanupPath = storedCleanupPath(root, pathname);

		await mkdir(cleanupRoot, { recursive: true });
		await writeFile(
			cleanupPath,
			JSON.stringify({
				dataFiles: [metadata.dataFile],
				etag: created.etag,
				pathname,
			}),
		);
		await rm(metadataPath, { force: true });

		await del(pathname, { ifMatch: created.etag });
		await assert.rejects(() => readFile(dataPath), { code: "ENOENT" });
		await assert.rejects(() => readFile(cleanupPath), { code: "ENOENT" });
		await assert.rejects(() => head(pathname), /does not exist|not found/iu);
	});
});

test("startup reconciliation removes interrupted writes without touching live data", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const livePathname = "recovery/live.txt";
		const live = await put(livePathname, "live payload", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const doomedPathname = "recovery/doomed.txt";
		const doomed = await put(doomedPathname, "doomed payload", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const liveMetadata = JSON.parse(
			await readFile(storedMetadataPath(root, livePathname), "utf8"),
		);
		const doomedMetadata = JSON.parse(
			await readFile(storedMetadataPath(root, doomedPathname), "utf8"),
		);
		const liveDataPath = await storedDataPath(root, livePathname);
		const doomedDataPath = await storedDataPath(root, doomedPathname);
		const cleanupDirectory = join(root, ".cleanup");
		const dataDirectory = join(root, ".data");
		const metadataDirectory = join(root, ".metadata");
		const multipartDirectory = join(
			root,
			".multipart",
			"0123456789abcdef0123456789abcdef",
		);
		const orphanDataPath = join(
			dataDirectory,
			".vercel-blob-local-data-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.blob",
		);
		const stagedNames = {
			cleanup: join(
				cleanupDirectory,
				".vercel-blob-local-111111111111111111111111.tmp",
			),
			data: join(
				dataDirectory,
				".vercel-blob-local-222222222222222222222222.tmp",
			),
			metadata: join(
				metadataDirectory,
				".vercel-blob-local-333333333333333333333333.tmp",
			),
			multipart: join(
				multipartDirectory,
				".vercel-blob-local-444444444444444444444444.tmp",
			),
		};
		const unrelatedDataPath = join(dataDirectory, "keep-me.txt");

		await mkdir(cleanupDirectory, { recursive: true });
		await mkdir(multipartDirectory, { recursive: true });
		await Promise.all([
			writeFile(
				storedCleanupPath(root, livePathname),
				JSON.stringify({
					dataFiles: [liveMetadata.dataFile],
					etag: live.etag,
					pathname: livePathname,
				}),
			),
			writeFile(
				storedCleanupPath(root, doomedPathname),
				JSON.stringify({
					dataFiles: [doomedMetadata.dataFile],
					etag: doomed.etag,
					pathname: doomedPathname,
				}),
			),
			writeFile(orphanDataPath, "orphan"),
			writeFile(stagedNames.cleanup, "staged"),
			writeFile(stagedNames.data, "staged"),
			writeFile(stagedNames.metadata, "staged"),
			writeFile(stagedNames.multipart, "staged"),
			writeFile(unrelatedDataPath, "untouched"),
		]);
		await rm(storedMetadataPath(root, doomedPathname), { force: true });

		await restart();
		assert.equal(await readReturnedUrl((await head(livePathname)).url), "live payload");
		assert.equal(await readFile(liveDataPath, "utf8"), "live payload");
		await assert.rejects(() => head(doomedPathname), /does not exist|not found/iu);
		await assert.rejects(() => readFile(doomedDataPath), { code: "ENOENT" });
		await assert.rejects(() => readFile(orphanDataPath), { code: "ENOENT" });
		await assert.rejects(
			() => readFile(storedCleanupPath(root, livePathname)),
			{ code: "ENOENT" },
		);
		await assert.rejects(
			() => readFile(storedCleanupPath(root, doomedPathname)),
			{ code: "ENOENT" },
		);

		for (const stagedPath of Object.values(stagedNames)) {
			await assert.rejects(() => readFile(stagedPath), { code: "ENOENT" });
		}

		assert.equal(await readFile(unrelatedDataPath, "utf8"), "untouched");
	});
});

test("unsupported legacy pathnames are ignored without breaking list", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const visible = await put("legacy/visible.txt", "visible", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const unsupportedEntries = [
			{
				body: "unsupported legacy payload",
				pathname: ".cleanup/old.txt",
				rejection: /reserved storage namespace/iu,
			},
			{
				body: "generation-shaped legacy payload",
				pathname:
					".data/.vercel-blob-local-data-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.blob",
				rejection: /reserved storage namespace/iu,
			},
			{
				body: "staging-shaped legacy payload",
				pathname:
					".metadata/.vercel-blob-local-555555555555555555555555.tmp",
				rejection: /reserved storage namespace/iu,
			},
			{
				body: "malformed Unicode legacy payload",
				pathname: "bad\ud800",
				rejection: /does not exist|not found/iu,
			},
		];

		await mkdir(join(root, ".metadata"), { recursive: true });

		for (const entry of unsupportedEntries) {
			const dataPath = join(root, ...entry.pathname.split("/"));
			await mkdir(dirname(dataPath), { recursive: true });
			await writeFile(dataPath, entry.body);
			await writeFile(
				legacyStoredMetadataPath(root, entry.pathname),
				JSON.stringify({
					access: "private",
					cacheControl: "public, max-age=2592000",
					contentDisposition: `inline; filename="${entry.pathname.split("/").at(-1)}"`,
					contentType: "text/plain; charset=utf-8",
					etag: createHash("sha256").update(entry.body).digest("hex"),
					pathname: entry.pathname,
					size: Buffer.byteLength(entry.body),
					uploadedAt: "2026-01-01T00:00:00.000Z",
				}),
			);
		}

		await restart();
		assert.deepEqual(
			(await list()).blobs.map(({ pathname }) => pathname),
			[visible.pathname],
		);

		for (const entry of unsupportedEntries) {
			await assert.rejects(
				() => head(entry.pathname),
				entry.rejection,
			);
			assert.equal(
				await readFile(join(root, ...entry.pathname.split("/")), "utf8"),
				entry.body,
			);
			assert.ok(
				await readFile(legacyStoredMetadataPath(root, entry.pathname), "utf8"),
			);
		}
	});
});

test(
	"startup reconciliation fails closed for linked metadata",
	{ skip: process.platform === "win32" ? "requires Unix symlinks" : false },
	async () => {
		await withBlobApi(async (_baseUrl, root, { restart }) => {
			const pathname = "recovery/linked.txt";
			const created = await put(pathname, "linked payload", {
				access: "private",
				addRandomSuffix: false,
				allowOverwrite: true,
			});
			const currentMetadataPath = storedMetadataPath(root, pathname);
			const linkedMetadataPath = join(root, "linked-metadata.json");
			const orphanDataPath = join(
				root,
				".data",
				".vercel-blob-local-data-cccccccccccccccccccccccccccccccc.blob",
			);

			await writeFile(
				linkedMetadataPath,
				await readFile(currentMetadataPath, "utf8"),
			);
			await rm(currentMetadataPath, { force: true });
			await symlink(linkedMetadataPath, currentMetadataPath, "file");
			await writeFile(orphanDataPath, "preserved while scan is incomplete");

			await restart();
			await assert.rejects(() => head(pathname), /not available/iu);
			assert.equal(
				await readFile(await storedDataPath(root, pathname), "utf8"),
				"linked payload",
			);
			assert.equal(
				await readFile(orphanDataPath, "utf8"),
				"preserved while scan is incomplete",
			);
			assert.ok(created.etag);
		});
	},
);

test(
	"case-only v2 metadata filenames remain live on Windows",
	{ skip: process.platform !== "win32" ? "requires case-insensitive NTFS" : false },
	async () => {
		await withBlobApi(async (_baseUrl, root, { restart }) => {
			const pathname = "recovery/case-only.txt";
			const created = await put(pathname, "case-only payload", {
				access: "private",
				addRandomSuffix: false,
				allowOverwrite: true,
			});
			const currentMetadataPath = storedMetadataPath(root, pathname);
			const caseOnlyMetadataPath = join(
				dirname(currentMetadataPath),
				basename(currentMetadataPath).toUpperCase(),
			);
			const currentDataPath = await storedDataPath(root, pathname);

			await renameFile(currentMetadataPath, caseOnlyMetadataPath);
			await restart();
			const persisted = await head(pathname);
			assert.equal(persisted.etag, created.etag);
			assert.equal(await readReturnedUrl(persisted.url), "case-only payload");
			assert.equal(await readFile(currentDataPath, "utf8"), "case-only payload");
		});
	},
);

test(
	"legacy case aliases never unlink another live blob on Windows",
	{ skip: process.platform !== "win32" ? "requires case-insensitive NTFS" : false },
	async () => {
		await withBlobApi(async (_baseUrl, root) => {
			async function seedAliases(upper, lower, body) {
				const etag = createHash("sha256").update(body).digest("hex");

				await writeFile(join(root, upper), body);

				for (const pathname of [upper, lower]) {
					await writeFile(
						legacyStoredMetadataPath(root, pathname),
						JSON.stringify({
							access: "private",
							cacheControl: "public, max-age=2592000",
							contentDisposition: `inline; filename="${pathname}"`,
							contentType: "text/plain; charset=utf-8",
							etag,
							pathname,
							size: Buffer.byteLength(body),
							uploadedAt: "2026-01-01T00:00:00.000Z",
						}),
					);
				}
			}

			await mkdir(join(root, ".metadata"), { recursive: true });
			await seedAliases("Foo", "foo", "shared overwrite payload");
			await seedAliases("Delete", "delete", "shared delete payload");

			assert.equal(await readReturnedUrl((await head("Foo")).url), "shared overwrite payload");
			assert.equal(await readReturnedUrl((await head("foo")).url), "shared overwrite payload");
			await put("Foo", "migrated upper payload", {
				access: "private",
				addRandomSuffix: false,
				allowOverwrite: true,
			});
			assert.equal(await readReturnedUrl((await head("Foo")).url), "migrated upper payload");
			assert.equal(await readReturnedUrl((await head("foo")).url), "shared overwrite payload");

			await del("Delete");
			await assert.rejects(() => head("Delete"), /does not exist|not found/iu);
			assert.equal(await readReturnedUrl((await head("delete")).url), "shared delete payload");
		});
	},
);

test("legacy metadata-shaped blob data cannot impersonate current metadata", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const victimPathname = "victim";
		const victimBody = "real legacy data";
		const victimDataPath = join(root, victimPathname);
		const victimMetadataPath = legacyStoredMetadataPath(root, victimPathname);
		const fakeDataFile =
			".vercel-blob-local-data-dddddddddddddddddddddddddddddddd.blob";
		const fakeDataPath = join(root, ".data", fakeDataFile);
		const metadataShapedPathname = `.metadata/${basename(
			storedMetadataPath(root, victimPathname),
		)}`;
		const metadataShapedDataPath = join(
			root,
			...metadataShapedPathname.split("/"),
		);
		const fakeMetadata = JSON.stringify({
			access: "private",
			cacheControl: "public, max-age=2592000",
			contentDisposition: 'inline; filename="victim"',
			contentType: "text/plain; charset=utf-8",
			dataFile: fakeDataFile,
			etag: createHash("sha256").update("fake generation data").digest("hex"),
			pathname: victimPathname,
			size: Buffer.byteLength("fake generation data"),
			uploadedAt: "2026-01-02T00:00:00.000Z",
		});
		const victimMetadata = {
			access: "private",
			cacheControl: "public, max-age=2592000",
			contentDisposition: 'inline; filename="victim"',
			contentType: "text/plain; charset=utf-8",
			etag: createHash("sha256").update(victimBody).digest("hex"),
			pathname: victimPathname,
			size: Buffer.byteLength(victimBody),
			uploadedAt: "2026-01-01T00:00:00.000Z",
		};
		const metadataShapedBlobMetadata = {
			access: "private",
			cacheControl: "public, max-age=2592000",
			contentDisposition: `inline; filename="${basename(metadataShapedPathname)}"`,
			contentType: "application/json",
			etag: createHash("sha256").update(fakeMetadata).digest("hex"),
			pathname: metadataShapedPathname,
			size: Buffer.byteLength(fakeMetadata),
			uploadedAt: "2026-01-01T00:00:00.000Z",
		};

		await mkdir(join(root, ".data"), { recursive: true });
		await mkdir(join(root, ".metadata"), { recursive: true });
		await writeFile(victimDataPath, victimBody);
		await writeFile(victimMetadataPath, JSON.stringify(victimMetadata));
		await writeFile(fakeDataPath, "fake generation data");
		await writeFile(metadataShapedDataPath, fakeMetadata);
		await writeFile(
			legacyStoredMetadataPath(root, metadataShapedPathname),
			JSON.stringify(metadataShapedBlobMetadata),
		);

		await restart();
		const victim = await head(victimPathname);
		assert.equal(victim.etag, victimMetadata.etag);
		assert.equal(await readReturnedUrl(victim.url), victimBody);
		assert.deepEqual(
			(await list()).blobs.map(({ pathname }) => pathname),
			[victimPathname],
		);
		await assert.rejects(
			() =>
				put(victimPathname, "must not overwrite legacy blob data", {
					access: "private",
					addRandomSuffix: false,
					allowOverwrite: true,
				}),
			/not available/iu,
		);
		assert.equal(await readFile(victimDataPath, "utf8"), victimBody);
		assert.ok(await readFile(victimMetadataPath, "utf8"));
		assert.equal(await readFile(metadataShapedDataPath, "utf8"), fakeMetadata);
	});
});

test("corrupt shadow metadata is isolated from healthy list entries", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const visible = await put("healthy/visible.txt", "visible", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const shadowedPathname = "legacy/shadowed.txt";
		const shadowedBody = "legacy remains on disk";
		const shadowedDataPath = join(root, ...shadowedPathname.split("/"));

		await mkdir(dirname(shadowedDataPath), { recursive: true });
		await writeFile(shadowedDataPath, shadowedBody);
		await writeFile(
			legacyStoredMetadataPath(root, shadowedPathname),
			JSON.stringify({
				access: "private",
				cacheControl: "public, max-age=2592000",
				contentDisposition: 'inline; filename="shadowed.txt"',
				contentType: "text/plain; charset=utf-8",
				etag: createHash("sha256").update(shadowedBody).digest("hex"),
				pathname: shadowedPathname,
				size: Buffer.byteLength(shadowedBody),
				uploadedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		await writeFile(storedMetadataPath(root, shadowedPathname), "{broken");

		await restart();
		assert.deepEqual(
			(await list()).blobs.map(({ pathname }) => pathname),
			[visible.pathname],
		);
		assert.equal(await readFile(shadowedDataPath, "utf8"), shadowedBody);
	});
});

test("reads legacy volumes and persists upgraded blobs across restarts", async () => {
	await withBlobApi(async (_baseUrl, root, { restart }) => {
		const pathname = "legacy/existing.txt";
		const legacyBody = "legacy payload";
		const legacyDataPath = join(root, ...pathname.split("/"));
		const legacyEtag = createHash("sha256")
			.update(legacyBody)
			.digest("hex");
		const legacyMetadata = {
			access: "private",
			cacheControl: "public, max-age=2592000",
			contentDisposition: 'inline; filename="existing.txt"',
			contentType: "text/plain; charset=utf-8",
			etag: legacyEtag,
			pathname,
			size: Buffer.byteLength(legacyBody),
			uploadedAt: "2026-01-01T00:00:00.000Z",
		};

		await mkdir(join(root, "legacy"), { recursive: true });
		await mkdir(join(root, ".metadata"), { recursive: true });
		await writeFile(legacyDataPath, legacyBody);
		await writeFile(
			legacyStoredMetadataPath(root, pathname),
			JSON.stringify(legacyMetadata),
		);

		const legacyHead = await head(pathname);
		assert.equal(legacyHead.etag, legacyEtag);
		assert.equal(legacyHead.size, Buffer.byteLength(legacyBody));
		assert.equal(await readReturnedUrl(legacyHead.url), legacyBody);
		assert.deepEqual(
			(await list({ prefix: "legacy/" })).blobs.map(({ pathname: listed }) =>
				listed,
			),
			[pathname],
		);

		await restart();
		assert.equal(await readReturnedUrl((await head(pathname)).url), legacyBody);

		const upgraded = await put(pathname, "upgraded payload", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
		});
		const upgradedMetadata = JSON.parse(
			await readFile(storedMetadataPath(root, pathname), "utf8"),
		);
		assert.match(
			upgradedMetadata.dataFile,
			/^[.]vercel-blob-local-data-[a-f0-9]{32}[.]blob$/u,
		);
		await assert.rejects(() => readFile(legacyDataPath), { code: "ENOENT" });
		await assert.rejects(
			() => readFile(legacyStoredMetadataPath(root, pathname)),
			{ code: "ENOENT" },
		);

		// Simulate a crash that left the old pointer and canonical payload behind.
		await writeFile(legacyDataPath, legacyBody);
		await writeFile(
			legacyStoredMetadataPath(root, pathname),
			JSON.stringify(legacyMetadata),
		);

		await restart();
		const persisted = await head(pathname);
		assert.equal(persisted.etag, upgraded.etag);
		assert.equal(await readReturnedUrl(persisted.url), "upgraded payload");
		await assert.rejects(() => readFile(legacyDataPath), { code: "ENOENT" });
		await assert.rejects(
			() => readFile(legacyStoredMetadataPath(root, pathname)),
			{ code: "ENOENT" },
		);

		const upgradedDataPath = await storedDataPath(root, pathname);
		await del(pathname);
		await assert.rejects(() => readFile(upgradedDataPath), { code: "ENOENT" });
		await assert.rejects(() => readFile(legacyDataPath), { code: "ENOENT" });
		await assert.rejects(
			() => readFile(legacyStoredMetadataPath(root, pathname)),
			{ code: "ENOENT" },
		);
		await assert.rejects(() => head(pathname), /does not exist|not found/iu);
	});
});

test("rejects a pathful configured public URL", async () => {
	const previousPublicUrl = process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL;
	const server = createVercelBlobLocalServer();

	process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL = "http://localhost:4545/blob";

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);

	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/health`);
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.match(body.error.message, /must be an origin/u);
	} finally {
		await new Promise((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});

		restoreEnv("VERCEL_BLOB_LOCAL_PUBLIC_URL", previousPublicUrl);
	}
});

test("rejects management writes without a configured token", async () => {
	const root = await mkdtemp(join(tmpdir(), "vercel-blob-local-auth-"));
	const previous = {
		localDir: process.env.VERCEL_BLOB_LOCAL_DIR,
		token: process.env.BLOB_READ_WRITE_TOKEN,
	};
	const server = createVercelBlobLocalServer();

	delete process.env.BLOB_READ_WRITE_TOKEN;
	process.env.VERCEL_BLOB_LOCAL_DIR = root;

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);

	try {
		const url = new URL(`http://127.0.0.1:${address.port}/`);
		url.searchParams.set("pathname", "auth/missing-token.txt");
		const response = await fetch(url, {
			body: "blocked",
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"x-vercel-blob-access": "public",
			},
			method: "PUT",
		});
		const body = await response.json();

		assert.equal(response.status, 403);
		assert.match(body.error.message, /BLOB_READ_WRITE_TOKEN is required/u);
	} finally {
		await new Promise((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});

		restoreEnv("BLOB_READ_WRITE_TOKEN", previous.token);
		restoreEnv("VERCEL_BLOB_LOCAL_DIR", previous.localDir);
		await rm(root, { force: true, recursive: true });
	}
});

test("rejects invalid list pagination", async () => {
	await withBlobApi(async (baseUrl) => {
		for (const [query, message] of [
			["limit=banana", /limit must be a positive integer/u],
			["cursor=2", /cursor is invalid/u],
		]) {
			const response = await fetch(`${baseUrl}/?${query}`, {
				headers: {
					authorization: `Bearer ${LOCAL_TOKEN}`,
				},
			});
			const body = await response.json();

			assert.equal(response.status, 400);
			assert.match(body.error.message, message);
		}
	});
});

test("list cursors remain stable while returned pages are deleted", async () => {
	await withBlobApi(async () => {
		const pathnames = Array.from(
			{ length: 5 },
			(_, index) => `pagination/${index}.txt`,
		);
		await Promise.all(
			pathnames.map((pathname) =>
				put(pathname, pathname, {
					access: "private",
					addRandomSuffix: false,
					allowOverwrite: true,
				}),
			),
		);

		const deleted = [];
		let cursor;

		do {
			const page = await list({ cursor, limit: 2, prefix: "pagination/" });
			assert.ok(page.blobs.length > 0);
			deleted.push(...page.blobs.map(({ pathname }) => pathname));
			await del(page.blobs.map(({ pathname }) => pathname));
			cursor = page.cursor;
		} while (cursor);

		assert.deepEqual(deleted, pathnames);
		assert.deepEqual((await list({ prefix: "pagination/" })).blobs, []);
	});
});

test("folded list pagination applies limits across blobs and folders", async () => {
	await withBlobApi(async () => {
		const pathnames = [
			"folded/0.txt",
			"folded/alpha/a.txt",
			"folded/bravo/b.txt",
			"folded/charlie/c.txt",
		];
		await Promise.all(
			pathnames.map((pathname) =>
				put(pathname, pathname, {
					access: "private",
					addRandomSuffix: false,
					allowOverwrite: true,
				}),
			),
		);

		const listedEntries = [];
		let cursor;

		do {
			const page = await list({
				cursor,
				limit: 2,
				mode: "folded",
				prefix: "folded/",
			});
			assert.ok(page.blobs.length + page.folders.length <= 2);
			listedEntries.push(
				...page.blobs.map(({ pathname }) => pathname),
				...page.folders,
			);
			cursor = page.cursor;
		} while (cursor);

		assert.deepEqual(listedEntries, [
			"folded/0.txt",
			"folded/alpha/",
			"folded/bravo/",
			"folded/charlie/",
		]);
	});
});

test("keeps returned URL origins scoped to each concurrent request", async () => {
	const root = await mkdtemp(join(tmpdir(), "vercel-blob-local-base-url-"));
	const previous = {
		apiUrl: process.env.VERCEL_BLOB_API_URL,
		baseUrl: process.env.VERCEL_BLOB_LOCAL_BASE_URL,
		localDir: process.env.VERCEL_BLOB_LOCAL_DIR,
		publicUrl: process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL,
		token: process.env.BLOB_READ_WRITE_TOKEN,
	};
	const server = createVercelBlobLocalServer();

	process.env.BLOB_READ_WRITE_TOKEN = LOCAL_TOKEN;
	process.env.VERCEL_BLOB_LOCAL_DIR = root;
	delete process.env.VERCEL_BLOB_API_URL;
	delete process.env.VERCEL_BLOB_LOCAL_BASE_URL;
	delete process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL;

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const [left, right] = await Promise.all([
			putWithHost(baseUrl, "left.local", "race/left.txt", "left", 25),
			putWithHost(baseUrl, "right.local", "race/right.txt", "right"),
		]);

		assert.equal(left.url, "http://left.local/race/left.txt");
		assert.equal(right.url, "http://right.local/race/right.txt");
	} finally {
		await new Promise((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});

		restoreEnv("BLOB_READ_WRITE_TOKEN", previous.token);
		restoreEnv("VERCEL_BLOB_API_URL", previous.apiUrl);
		restoreEnv("VERCEL_BLOB_LOCAL_BASE_URL", previous.baseUrl);
		restoreEnv("VERCEL_BLOB_LOCAL_DIR", previous.localDir);
		restoreEnv("VERCEL_BLOB_LOCAL_PUBLIC_URL", previous.publicUrl);
		await rm(root, { force: true, recursive: true });
	}
});
