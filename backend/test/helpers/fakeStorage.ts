import {
  UploadNotFoundError,
  type ObjectStorage,
  type PartInfo,
} from '../../src/storage/objectStorage.js';

export class FakeStorage implements ObjectStorage {
  uploads = new Map<string, { key: string; parts: Map<number, PartInfo> }>();
  completedKeys = new Set<string>();
  createCount = 0;

  async createMultipartUpload(key: string): Promise<string> {
    const id = `upload-${++this.createCount}`;
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `http://fake-storage/${key}?uploadId=${uploadId}&part=${partNumber}`;
  }

  async listParts(_key: string, uploadId: string): Promise<PartInfo[]> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new UploadNotFoundError(uploadId);
    return [...upload.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (!this.uploads.has(uploadId)) throw new UploadNotFoundError(uploadId);
    this.uploads.delete(uploadId);
    this.completedKeys.add(key);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }

  async objectExists(key: string): Promise<boolean> {
    return this.completedKeys.has(key);
  }

  /** Test helper: pretend the browser uploaded a part. */
  putPart(uploadId: string, partNumber: number, size: number): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`no such upload ${uploadId}`);
    upload.parts.set(partNumber, { partNumber, size, etag: `etag-${partNumber}` });
  }
}