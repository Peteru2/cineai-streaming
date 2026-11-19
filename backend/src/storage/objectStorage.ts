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
}