import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Config } from '../config.js';
import type { PostgresVideoStore, VideoRecord } from '../db/postgresVideoStore.js';
import { transitionVideo } from '../domain/transition.js';
import { VIDEO_STATUSES, type VideoStatus } from '../domain/status.js';
import { UploadNotFoundError, type ObjectStorage } from '../storage/objectStorage.js';
import { masterKey } from '../storage/keys.js';

export interface VideoRoutesDeps {
  store: PostgresVideoStore;
  storage: ObjectStorage;
  config: Config;
  /** Called exactly once per video, after it becomes `uploaded`. Next step: enqueue the job. */
  onUploaded?: (videoId: string) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

// Stand-in for real login. Replace with real authentication later (see write-up).
function requireCreator(req: Request): string {
  const creator = req.header('x-creator-id');
  if (!creator) throw new HttpError(401, 'unauthenticated', 'Missing x-creator-id header');
  return creator;
}

const storageKey = masterKey;

function toView(v: VideoRecord) {
  return {
    id: v.id,
    filename: v.filename,
    sizeBytes: v.sizeBytes,
    status: v.status,
    failureReason: v.failureReason,
    createdAt: v.createdAt,
  };
}

function parseCreateBody(body: unknown, config: Config) {
  const b = (body ?? {}) as Record<string, unknown>;
  const { filename, sizeBytes, contentType } = b;

  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255) {
    throw new HttpError(400, 'invalid_filename', 'filename must be 1 to 255 characters');
  }
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new HttpError(400, 'invalid_size', 'sizeBytes must be a positive integer');
  }
  if (sizeBytes > config.maxFileSizeBytes) {
    throw new HttpError(413, 'file_too_large', `Maximum file size is ${config.maxFileSizeBytes} bytes`);
  }
  if (typeof contentType !== 'string' || !config.allowedContentTypes.includes(contentType)) {
    throw new HttpError(415, 'unsupported_type', `Allowed types: ${config.allowedContentTypes.join(', ')}`);
  }
  return { filename, sizeBytes, contentType };
}

export function videoRoutes(deps: VideoRoutesDeps): Router {
  const { store, storage, config } = deps;
  const router = Router();

  async function loadOwned(req: Request): Promise<VideoRecord> {
    const creator = requireCreator(req);
    const id = String(req.params.id);
    const video = UUID.test(id) ? await store.getVideo(id) : null;
    // Someone else's video looks exactly like a missing one.
    if (!video || video.creatorId !== creator) {
      throw new HttpError(404, 'not_found', 'Video not found');
    }
    return video;
  }

  // Idempotent: safe to run again and again for the same video.
  async function ensureMultipartUpload(video: VideoRecord): Promise<VideoRecord> {
    if (video.uploadId) return video;

    const uploadId = await storage.createMultipartUpload(storageKey(video.id), video.contentType);
    if (await store.setUploadIdIfEmpty(video.id, uploadId)) {
      return { ...video, uploadId };
    }
    // Another request set it first. Throw ours away and use theirs.
    await storage.abortMultipartUpload(storageKey(video.id), uploadId);
    const fresh = await store.getVideo(video.id);
    if (!fresh) throw new HttpError(404, 'not_found', 'Video not found');
    return fresh;
  }

  // What is stored, what is missing, and fresh signed URLs for the missing parts.
  async function buildPlan(video: VideoRecord) {
    if (!video.uploadId) throw new HttpError(500, 'no_upload', 'Upload was not started');

    const stored = await storage.listParts(storageKey(video.id), video.uploadId);
    const have = new Set(stored.map((p) => p.partNumber));
    const totalParts = Math.ceil(video.sizeBytes / config.partSizeBytes);

    const missingParts = [];
    for (let n = 1; n <= totalParts; n++) {
      if (have.has(n)) continue;
      const offset = (n - 1) * config.partSizeBytes;
      missingParts.push({
        partNumber: n,
        offset,
        size: Math.min(config.partSizeBytes, video.sizeBytes - offset),
        url: await storage.presignUploadPart(
          storageKey(video.id),
          video.uploadId,
          n,
          config.urlExpirySeconds,
        ),
      });
    }

    return {
      partSizeBytes: config.partSizeBytes,
      totalParts,
      uploadedParts: stored.map((p) => ({ partNumber: p.partNumber, size: p.size })),
      missingParts,
      urlsExpireInSeconds: config.urlExpirySeconds,
    };
  }

  // 1. Start (or find) an upload
  router.post(
    '/',
    wrap(async (req, res) => {
      const creator = requireCreator(req);
      if (!config.uploadsEnabled) {
        throw new HttpError(503, 'uploads_paused', 'Uploads are temporarily paused. Playback is unaffected.');
      }
      const key = req.header('idempotency-key');
      if (!key || key.length < 8 || key.length > 128) {
        throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key header must be 8 to 128 characters');
      }

      const input = parseCreateBody(req.body, config);
      const { video, created } = await store.createVideo({
        creatorId: creator,
        idempotencyKey: key,
        ...input,
      });

      if (video.status !== 'uploading') {
        res.status(200).json({ video: toView(video) }); // a replay after completion
        return;
      }

      const ready = await ensureMultipartUpload(video);
      res.status(created ? 201 : 200).json({ video: toView(ready), upload: await buildPlan(ready) });
    }),
  );

  // 2. Unfinished uploads (for resuming after a closed tab)
  router.get(
    '/',
    wrap(async (req, res) => {
      const creator = requireCreator(req);
      const status = req.query.status;
      if (status !== undefined && !VIDEO_STATUSES.includes(status as VideoStatus)) {
        throw new HttpError(400, 'invalid_status', 'Unknown status filter');
      }
      const videos = await store.listByCreator(creator, status as VideoStatus | undefined);
      res.json({ videos: videos.map(toView) });
    }),
  );

  // 3. Status for the creator's screen
  router.get(
    '/:id',
    wrap(async (req, res) => {
      res.json({ video: toView(await loadOwned(req)) });
    }),
  );

  // 4. Resume: ask storage what exists, hand out fresh URLs for the rest
  router.get(
    '/:id/parts',
    wrap(async (req, res) => {
      const video = await loadOwned(req);
      if (video.status !== 'uploading') {
        throw new HttpError(409, 'not_uploading', `Video is ${video.status}`, { status: video.status });
      }
      res.json({ video: toView(video), upload: await buildPlan(video) });
    }),
  );

  // 5. Complete. The browser's opinion of what was uploaded is never used.
  router.post(
    '/:id/complete',
    wrap(async (req, res) => {
      const video = await loadOwned(req);

      // A repeat signal: already done, nothing more to do.
      if (video.status !== 'uploading') {
        res.json({ video: toView(video) });
        return;
      }
      if (!video.uploadId) throw new HttpError(409, 'no_upload', 'Upload was not started');

      const key = storageKey(video.id);
      const totalParts = Math.ceil(video.sizeBytes / config.partSizeBytes);
      let alreadyAssembled = false;

      try {
        const parts = (await storage.listParts(key, video.uploadId)).sort(
          (a, b) => a.partNumber - b.partNumber,
        );

        const have = new Set(parts.map((p) => p.partNumber));
        const missing: number[] = [];
        for (let n = 1; n <= totalParts; n++) if (!have.has(n)) missing.push(n);
        if (missing.length > 0) {
          throw new HttpError(409, 'incomplete', 'Some parts are still missing', { missingParts: missing });
        }

        const storedBytes = parts.reduce((sum, p) => sum + p.size, 0);
        if (storedBytes !== video.sizeBytes) {
          throw new HttpError(409, 'size_mismatch', 'Uploaded bytes do not match the declared size', {
            declared: video.sizeBytes,
            stored: storedBytes,
          });
        }

        await storage.completeMultipartUpload(key, video.uploadId, parts);
      } catch (err) {
        // A parallel request may have assembled it already: the upload ID is gone.
        if (!(err instanceof UploadNotFoundError)) throw err;
        alreadyAssembled = true;
      }

      if (alreadyAssembled && !(await storage.objectExists(key))) {
        throw new HttpError(409, 'upload_lost', 'Upload no longer exists in storage; please restart it');
      }

      // The single atomic step. Only one request in a race gets 'applied'.
      const result = await transitionVideo(store, video.id, 'uploading', 'uploaded');
      if (result === 'applied' && deps.onUploaded) {
        try {
          await deps.onUploaded(video.id);
        } catch (err) {
          // The video is safely `uploaded`. A later reconciliation pass will queue it.
          console.error(`onUploaded failed for ${video.id}`, err);
        }
      }

      const fresh = await store.getVideo(video.id);
      res.json({ video: toView(fresh ?? video) });
    }),
  );

  return router;
}