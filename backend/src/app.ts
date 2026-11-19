import express, { type ErrorRequestHandler, type Express } from 'express';
import { HttpError, videoRoutes, type VideoRoutesDeps } from './api/videoRoutes.js';

export function createApp(deps?: VideoRoutesDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (deps) {
    app.use('/videos', videoRoutes(deps));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  };
  app.use(onError);

  return app;
}