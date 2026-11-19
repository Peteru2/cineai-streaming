import { PermanentProcessingError } from '../processor.js';
import { CommandError, runCommand, type RunOptions } from './command.js';
import type { ProcessingConfig } from './processingConfig.js';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
}

/** Turns ffprobe's JSON into the few facts we need. Pure, so easy to test. */
export function parseProbe(raw: unknown): ProbeResult {
  const data = (raw ?? {}) as { format?: { duration?: string }; streams?: any[] };
  const streams = Array.isArray(data.streams) ? data.streams : [];

  // Ignore cover-art images that some files carry as a fake "video" track.
  const video = streams.find((s) => s?.codec_type === 'video' && s?.disposition?.attached_pic !== 1);
  if (!video) throw new PermanentProcessingError('The file has no video track');

  const width = Number(video.width);
  const height = Number(video.height);
  if (!(width > 0) || !(height > 0)) {
    throw new PermanentProcessingError('The video track has no valid dimensions');
  }

  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new PermanentProcessingError('Could not determine the video length');
  }

  return {
    durationSeconds: duration,
    width,
    height,
    hasAudio: streams.some((s) => s?.codec_type === 'audio'),
    videoCodec: String(video.codec_name ?? 'unknown'),
  };
}

export function validateProbe(probe: ProbeResult, config: ProcessingConfig): void {
  if (probe.durationSeconds > config.maxDurationSeconds) {
    throw new PermanentProcessingError(
      `The video is longer than ${Math.round(config.maxDurationSeconds / 60)} minutes`,
    );
  }
  if (probe.height > config.maxHeight) {
    throw new PermanentProcessingError(`The video is taller than ${config.maxHeight} pixels`);
  }
}

export async function probeFile(
  filePath: string,
  config: ProcessingConfig,
  run: RunOptions,
): Promise<ProbeResult> {
  const unreadable = () => new PermanentProcessingError('The file could not be read as a video');

  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      config.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      run,
    ));
  } catch (err) {
    if (err instanceof CommandError) throw unreadable();
    throw err; // not installed, stopped, or timed out: not the file's fault
  }

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw unreadable();
  }

  const probe = parseProbe(json);
  validateProbe(probe, config);
  return probe;
}