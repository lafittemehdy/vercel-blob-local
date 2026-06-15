export type BlobAccessType = "private" | "public";

export type PutBody =
	| ArrayBuffer
	| Blob
	| Buffer
	| NodeJS.ReadableStream
	| ReadableStream<Uint8Array>
	| string;

export interface BlobCommandOptions {
	abortSignal?: AbortSignal;
	token?: string;
}

export interface CommonCreateBlobOptions extends BlobCommandOptions {
	access: BlobAccessType;
	addRandomSuffix?: boolean;
	allowOverwrite?: boolean;
	cacheControlMaxAge?: number;
	contentType?: string;
	ifMatch?: string;
	maximumSizeInBytes?: number;
}

export interface UploadProgressEvent {
	loaded: number;
	percentage: number;
	total: number;
}

export type OnUploadProgressCallback = (event: UploadProgressEvent) => void;

export interface PutCommandOptions extends CommonCreateBlobOptions {
	multipart?: boolean;
	onUploadProgress?: OnUploadProgressCallback;
}

export interface DeleteCommandOptions extends BlobCommandOptions {
	ifMatch?: string;
}

export interface GetCommandOptions extends BlobCommandOptions {
	access: BlobAccessType;
	headers?: HeadersInit;
	ifNoneMatch?: string;
	useCache?: boolean;
}

export interface HeadBlobResult {
	cacheControl: string;
	contentDisposition: string;
	contentType: string;
	downloadUrl: string;
	etag: string;
	pathname: string;
	size: number;
	uploadedAt: Date;
	url: string;
}

export interface PutBlobResult {
	contentDisposition: string;
	contentType: string;
	downloadUrl: string;
	etag: string;
	pathname: string;
	url: string;
}

type GetBlobResultBlobBase = {
	cacheControl: string;
	contentDisposition: string;
	downloadUrl: string;
	etag: string;
	pathname: string;
	uploadedAt: Date;
	url: string;
};

export type GetBlobResult =
	| {
			blob: GetBlobResultBlobBase & {
				contentType: string;
				size: number;
			};
			headers: Headers;
			statusCode: 200;
			stream: ReadableStream<Uint8Array>;
	  }
	| {
			blob: GetBlobResultBlobBase & {
				contentType: null;
				size: null;
			};
			headers: Headers;
			statusCode: 304;
			stream: null;
	  };

export interface ListBlobResultBlob {
	downloadUrl: string;
	etag: string;
	pathname: string;
	size: number;
	uploadedAt: Date;
	url: string;
}

export interface ListBlobResult {
	blobs: ListBlobResultBlob[];
	cursor?: string;
	hasMore: boolean;
}

export interface ListFoldedBlobResult extends ListBlobResult {
	folders: string[];
}

export interface ListCommandOptions<
	Mode extends "expanded" | "folded" | undefined = undefined,
> extends BlobCommandOptions {
	cursor?: string;
	limit?: number;
	mode?: Mode;
	prefix?: string;
}

export type ListCommandResult<
	Mode extends "expanded" | "folded" | undefined = undefined,
> = Mode extends "folded" ? ListFoldedBlobResult : ListBlobResult;

export type CopyCommandOptions = CommonCreateBlobOptions;

export interface CopyBlobResult {
	contentDisposition: string;
	contentType: string;
	downloadUrl: string;
	etag: string;
	pathname: string;
	url: string;
}

export type CreateFolderCommandOptions = Pick<
	CommonCreateBlobOptions,
	"abortSignal" | "token"
> & {
	access?: BlobAccessType;
};

export interface CreateFolderResult {
	pathname: string;
	url: string;
}

export type Part = {
	etag: string;
	partNumber: number;
};

export interface PartInput {
	blob: PutBody;
	partNumber: number;
}

export type UploadPartCommandOptions = CommonCreateBlobOptions & {
	key: string;
	onUploadProgress?: OnUploadProgressCallback;
	partNumber: number;
	uploadId: string;
};

export type CompleteMultipartUploadCommandOptions = CommonCreateBlobOptions & {
	key: string;
	uploadId: string;
};
