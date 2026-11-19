export interface ProcessingConfig {
  ffmpegPath: string;
  ffprobePath: string;
  preset: string; // x264 speed/quality trade-off: ultrafast ... veryfast ... slow
  fps: number;
  segmentSeconds: number;
  maxDurationSeconds: number;
  maxHeight: number;
  jobTimeoutMs: number;
  uploadConcurrency: number;
}

export function loadProcessingConfig(env: NodeJS.ProcessEnv = process.env): ProcessingConfig {
  return {
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    preset: env.FFMPEG_PRESET ?? 'veryfast',
    fps: Number(env.OUTPUT_FPS ?? 30),
    segmentSeconds: Number(env.HLS_SEGMENT_SECONDS ?? 4),
    maxDurationSeconds: Number(env.MAX_DURATION_MINUTES ?? 60) * 60,
    maxHeight: Number(env.MAX_SOURCE_HEIGHT ?? 4320),
    jobTimeoutMs: Number(env.JOB_TIMEOUT_MINUTES ?? 30) * 60_000,
    uploadConcurrency: Number(env.UPLOAD_CONCURRENCY ?? 8),
  };
}