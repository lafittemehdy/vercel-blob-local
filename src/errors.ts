export class BlobError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

export class BlobAccessError extends BlobError {
	constructor(message = "Access denied") {
		super(message);
	}
}

export class BlobContentTypeNotAllowedError extends BlobError {}
export class BlobPathnameMismatchError extends BlobError {}

export class BlobClientTokenExpiredError extends BlobError {
	constructor() {
		super("Client token expired");
	}
}

export class BlobFileTooLargeError extends BlobError {}

export class BlobStoreNotFoundError extends BlobError {
	constructor() {
		super("Blob store not found");
	}
}

export class BlobStoreSuspendedError extends BlobError {
	constructor() {
		super("Blob store suspended");
	}
}

export class BlobUnknownError extends BlobError {
	constructor() {
		super("Unknown blob error");
	}
}

export class BlobNotFoundError extends BlobError {
	constructor() {
		super("Blob not found");
	}
}

export class BlobServiceNotAvailable extends BlobError {
	constructor() {
		super("Blob service not available");
	}
}

export class BlobServiceRateLimited extends BlobError {
	readonly retryAfter: number;

	constructor(seconds = 60) {
		super("Blob service rate limited");
		this.retryAfter = seconds;
	}
}

export class BlobRequestAbortedError extends BlobError {
	constructor() {
		super("Blob request aborted");
	}
}

export class BlobPreconditionFailedError extends BlobError {
	constructor() {
		super("Blob precondition failed");
	}
}
