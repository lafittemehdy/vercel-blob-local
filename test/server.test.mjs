import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	copy,
	createMultipartUploader,
	del,
	get as sdkGet,
	getDownloadUrl,
	head,
	list,
	put,
} from "@vercel/blob";

import { createVercelBlobLocalServer } from "../dist/server.js";

const LOCAL_TOKEN = "vercel_blob_rw_local_test";

async function withBlobApi(fn) {
	const root = await mkdtemp(join(tmpdir(), "vercel-blob-local-api-"));
	const previous = {
		apiUrl: process.env.VERCEL_BLOB_API_URL,
		localDir: process.env.VERCEL_BLOB_LOCAL_DIR,
		publicUrl: process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL,
		retries: process.env.VERCEL_BLOB_RETRIES,
		token: process.env.BLOB_READ_WRITE_TOKEN,
	};
	const server = createVercelBlobLocalServer();

	process.env.BLOB_READ_WRITE_TOKEN = LOCAL_TOKEN;
	process.env.VERCEL_BLOB_LOCAL_DIR = root;
	process.env.VERCEL_BLOB_RETRIES = "0";

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);
	const baseUrl = `http://127.0.0.1:${address.port}`;

	process.env.VERCEL_BLOB_API_URL = baseUrl;
	process.env.VERCEL_BLOB_LOCAL_PUBLIC_URL = baseUrl;

	try {
		await fn(baseUrl);
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
		restoreEnv("VERCEL_BLOB_LOCAL_DIR", previous.localDir);
		restoreEnv("VERCEL_BLOB_LOCAL_PUBLIC_URL", previous.publicUrl);
		restoreEnv("VERCEL_BLOB_RETRIES", previous.retries);
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

test("serves the official @vercel/blob API over HTTP", async () => {
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

		await assert.rejects(
			() => sdkGet(publicBlob.url, { access: "public" }),
			/Invalid URL: the URL does not point to a Vercel Blob store/u,
		);

		const copied = await copy("api/a.txt", "api/b.txt", {
			access: "private",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: "text/plain",
		});

		assert.equal(await readReturnedUrl(copied.url), "hello");

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

		const listed = await list({ prefix: "api/" });
		assert.deepEqual(
			listed.blobs.map((blob) => blob.pathname).sort(),
			["api/a.txt", "api/b.txt", "api/multipart.txt", "api/public.txt"],
		);

		await del(["api/a.txt", "api/b.txt", "api/multipart.txt", "api/public.txt"]);
		await assert.rejects(() => head("api/a.txt"), {
			name: "Error",
		});
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
		const response = await fetch(`${baseUrl}/?limit=banana`, {
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
			},
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.match(body.error.message, /limit must be a positive integer/u);
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
