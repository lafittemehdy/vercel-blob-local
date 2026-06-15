import { AsyncLocalStorage } from "node:async_hooks";

import { normalizePathname } from "./blob-paths.js";

const baseUrlStorage = new AsyncLocalStorage<string>();

function getBaseUrl(): string {
	return (
		baseUrlStorage.getStore() ??
		process.env.VERCEL_BLOB_LOCAL_BASE_URL ??
		"http://localhost:3000"
	).replace(/\/+$/u, "");
}

export function runWithBaseUrl<T>(baseUrl: string, callback: () => T): T {
	return baseUrlStorage.run(baseUrl.replace(/\/+$/u, ""), callback);
}

export function buildUrl(pathname: string): string {
	return `${getBaseUrl()}/${pathname
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;
}

export function getDownloadUrl(urlOrPathname: string): string {
	const source = /^[a-z][a-z\d+.-]*:\/\//iu.test(urlOrPathname)
		? urlOrPathname
		: buildUrl(normalizePathname(urlOrPathname));
	const url = new URL(source);
	url.searchParams.set("download", "1");
	return url.toString();
}
