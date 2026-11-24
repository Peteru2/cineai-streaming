import { Router } from 'express';
import type { Config } from '../config.js';
import type { PostgresVideoStore } from '../db/postgresVideoStore.js';
import { masterManifestKey, posterKey } from '../storage/keys.js';
import { HttpError, UUID, wrap } from './videoRoutes.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

/** Anything unusable falls back to the default. Anything huge is capped. */
export function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function playbackRoutes(deps: { store: PostgresVideoStore; config: Config }): Router {
  const router = Router();
  const base = deps.config.mediaBaseUrl;

  // The film list. Public on purpose, and it exposes only what a viewer needs.
  router.get(
    '/',
    wrap(async (req, res) => {
      const videos = await deps.store.listReady(parseLimit(req.query.limit));
      res.set('Cache-Control', 'public, max-age=30');
      res.json({
        films: videos.map((v) => ({
          id: v.id,
          filename: v.filename,
          posterUrl: `${base}/${posterKey(v.id)}`,
          createdAt: v.createdAt,
        })),
      });
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const video = UUID.test(id) ? await deps.store.getVideo(id) : null;
      if (!video) throw new HttpError(404, 'not_found', 'Video not found');

      if (video.status !== 'ready') {
        throw new HttpError(409, 'not_ready', `Video is ${video.status}`, { status: video.status });
      }

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