import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ObjectNotFoundError,
  UploadNotFoundError,
  type ObjectStorage,
  type PartInfo,
} from './objectStorage.js';

export interface S3StorageOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: 'us-east-1', // required by the SDK; ignored by most S3-compatible stores
      endpoint: options.endpoint,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true, // http://host/bucket/key instead of http://bucket.host/key
      // Newer SDK versions add checksum headers that many S3-compatible stores
      // do not expect. Only add them when the protocol requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3Storage {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      accessKeyId: env.S3_ACCESS_KEY ?? 'rustfsadmin',
      secretAccessKey: env.S3_SECRET_KEY ?? 'rustfsadmin',
      bucket: env.S3_BUCKET ?? 'cineai',
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error('Storage returned no upload ID');
    return res.UploadId;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<PartInfo[]> {
    try {
      const res = await this.client.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MaxParts: 1000 }),
      );
      return (res.Parts ?? []).map((p) => ({
        partNumber: p.PartNumber ?? 0,
        size: p.Size ?? 0,
        etag: p.ETag ?? '',
      }));
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchUpload') throw new UploadNotFoundError(uploadId);
      throw err;
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: PartInfo[]): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchUpload') throw new UploadNotFoundError(uploadId);
      throw err;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchUpload') return; // already gone is fine
      throw err;
    }
  }

    async downloadToFile(key: string, filePath: string): Promise<void> {
    let res: GetObjectCommandOutput;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
        throw new ObjectNotFoundError(key);
      }
      throw err;
    }
    if (!res.Body) throw new ObjectNotFoundError(key);
    await pipeline(res.Body as Readable, createWriteStream(filePath));
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}