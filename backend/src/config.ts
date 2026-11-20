export interface Config {
  partSizeBytes: number;
  maxFileSizeBytes: number;
  urlExpirySeconds: number;
  uploadsEnabled: boolean;
  allowedContentTypes: readonly string[];
  /** Where players fetch playlists and segments. In production, the CDN's address. */
  mediaBaseUrl: string;
}

const MB = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    partSizeBytes: Number(env.PART_SIZE_MB ?? 10) * MB,
    maxFileSizeBytes: Number(env.MAX_FILE_SIZE_GB ?? 5) * 1024 * MB,
    urlExpirySeconds: Number(env.URL_EXPIRY_SECONDS ?? 3600),
    uploadsEnabled: env.UPLOADS_ENABLED !== 'false', // the kill switch
    allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'],
    mediaBaseUrl: (env.MEDIA_BASE_URL ?? 'http://127.0.0.1:9000/cineai').replace(/\/+$/, ''),
  };

  // S3 rules: every part except the last must be at least 5 MB,
  // and one upload may have at most 1000 parts here (the real limit is 10,000).
  if (config.partSizeBytes < 5 * MB) {
    throw new Error('PART_SIZE_MB must be at least 5');
  }
  if (Math.ceil(config.maxFileSizeBytes / config.partSizeBytes) > 1000) {
    throw new Error('Max file size needs more than 1000 parts; raise PART_SIZE_MB');
  }
  return config;
}