export interface PartInfo {
  partNumber: number;
  size: number;
  etag: string;
}

export class UploadNotFoundError extends Error {
  constructor(uploadId: string) {
    super(`Upload not found in storage: ${uploadId}`);
    this.name = 'UploadNotFoundError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found in storage: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export interface ObjectStorage {
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string>;
  listParts(key: string, uploadId: string): Promise<PartInfo[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: PartInfo[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  /** Streams an object to a file on disk. Throws ObjectNotFoundError if it does not exist. */
  downloadToFile(key: string, filePath: string): Promise<void>;
  /** For small objects only (segments, playlists, images). */
  putObject(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
}