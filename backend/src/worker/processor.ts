import type { VideoRecord } from '../db/postgresVideoStore.js';

export interface VideoProcessor {
  /** Does the heavy work. Must stop promptly when `signal` is aborted. */
  process(video: VideoRecord, signal: AbortSignal): Promise<void>;
}

/** Throw this for problems that retrying cannot fix (for example, a corrupt file). */
export class PermanentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

/**
 * Temporary stand-in until the FFmpeg step. It marks videos `ready`
 * without producing any playable output, so it is only for wiring tests.
 */
export class PlaceholderProcessor implements VideoProcessor {
  async process(video: VideoRecord): Promise<void> {
    console.log(`(placeholder) pretending to transcode ${video.id}`);
  }
}