import path from 'node:path';
import type { ProbeResult } from './probe.js';
import type { ProcessingConfig } from './processingConfig.js';

export interface Rung {
  name: string;
  width: number;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

const LADDER = [
  { height: 1080, videoKbps: 5000, audioKbps: 128 },
  { height: 720, videoKbps: 2800, audioKbps: 128 },
  { height: 480, videoKbps: 1400, audioKbps: 96 },
  { height: 360, videoKbps: 700, audioKbps: 96 },
] as const;

const roundEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const floorEven = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Rungs at or below the source's height. Never upscales. */
export function selectLadder(probe: ProbeResult): Rung[] {
  const rungs: Rung[] = LADDER.filter((r) => r.height <= probe.height).map((r) => ({
    name: `${r.height}p`,
    height: r.height,
    width: roundEven((probe.width * r.height) / probe.height),
    videoKbps: r.videoKbps,
    audioKbps: r.audioKbps,
  }));
  if (rungs.length > 0) return rungs;

  // The source is smaller than every rung: keep its own size.
  const lowest = LADDER[LADDER.length - 1]!;
  const height = floorEven(probe.height);
  return [
    {
      name: `${height}p`,
      height,
      width: floorEven(probe.width),
      videoKbps: lowest.videoKbps,
      audioKbps: lowest.audioKbps,
    },
  ];
}

const bandwidth = (r: Rung) => Math.round((r.videoKbps * 1.07 + r.audioKbps) * 1000);

/** The master playlist: the menu a player reads first. Lowest quality first. */
export function buildMasterPlaylist(rungs: Rung[], fps: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of [...rungs].sort((a, b) => bandwidth(a) - bandwidth(b))) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth(r)},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${fps.toFixed(3)}`,
      `${r.name}/index.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}

/** The FFmpeg command for one rung. Pure, so the settings are easy to test. */
export function buildRenditionArgs(
  input: string,
  outDir: string,
  rung: Rung,
  hasAudio: boolean,
  config: ProcessingConfig,
): string[] {
  const gop = config.fps * config.segmentSeconds; // keyframe every segment, on every rung

  return [
    '-y',
    '-loglevel', 'error',
    '-nostats',
    '-i', input,
    '-map', '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []),
    // Constant frame rate, scaled down, in a format every device can decode.
    '-vf', `fps=${config.fps},scale=-2:${rung.height},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', config.preset,
    '-profile:v', 'main',
    '-b:v', `${rung.videoKbps}k`,
    '-maxrate', `${Math.round(rung.videoKbps * 1.07)}k`,
    '-bufsize', `${rung.videoKbps * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    ...(hasAudio
      ? ['-c:a', 'aac', '-b:a', `${rung.audioKbps}k`, '-ar', '48000', '-ac', '2',
         '-af', 'aresample=async=1:first_pts=0']
      : ['-an']),
    '-f', 'hls',
    '-hls_time', String(config.segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];
}