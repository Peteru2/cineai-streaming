import type { UploadPlan } from './uploader';

export interface VideoView {
  id: string;
  filename: string;
  sizeBytes: number;
  status: string;
  failureReason: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { creator?: string; key?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.creator) headers['x-creator-id'] = opts.creator;
  if (opts.key) headers['idempotency-key'] = opts.key;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Same creator + same key always returns the same video (and a fresh plan while uploading). */
export const createUpload = (
  creator: string,
  key: string,
  file: { filename: string; sizeBytes: number; contentType: string },
) => call<{ video: VideoView; upload?: UploadPlan }>('POST', '/videos', { creator, key, body: file });

export const getParts = (creator: string, id: string) =>
  call<{ video: VideoView; upload: UploadPlan }>('GET', `/videos/${id}/parts`, { creator });

export const completeUpload = (creator: string, id: string) =>
  call<{ video: VideoView }>('POST', `/videos/${id}/complete`, { creator });

export const getVideo = (creator: string, id: string) =>
  call<{ video: VideoView }>('GET', `/videos/${id}`, { creator });

export const getPlayback = (id: string) =>
  call<{ id: string; filename: string; manifestUrl: string; posterUrl: string }>('GET', `/watch/${id}`);