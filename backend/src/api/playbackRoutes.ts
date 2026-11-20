import { Router } from 'express';
import type { Config } from '../config.js';
import type { PostgresVideoStore } from '../db/postgresVideoStore.js';
import { masterManifestKey, posterKey } from '../storage/keys.js';
import { HttpError, UUID, wrap } from './videoRoutes.js';

export function playbackRoutes(deps: { store: PostgresVideoStore; config: Config }): Router {
  const router = Router();

  // Public on purpose: viewers are not creators. The video ID is unguessable,
  // but there is no visibility or permission model yet (see the write-up).
  router.get(
    '/:id',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const video = UUID.test(id) ? await deps.store.getVideo(id) : null;
      if (!video) throw new HttpError(404, 'not_found', 'Video not found');

      if (video.status !== 'ready') {
        throw new HttpError(409, 'not_ready', `Video is ${video.status}`, { status: video.status });
      }

      const base = deps.config.mediaBaseUrl;
      res.json({
        id: video.id,
        filename: video.filename,
        manifestUrl: `${base}/${masterManifestKey(id)}`,
        posterUrl: `${base}/${posterKey(id)}`,
      });
    }),
  );

  return router;
}