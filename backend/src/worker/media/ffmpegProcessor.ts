import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VideoRecord } from '../../db/postgresVideoStore.js';
import { hlsPrefix, masterKey, masterManifestKey } from '../../storage/keys.js';
import { ObjectNotFoundError, type ObjectStorage } from '../../storage/objectStorage.js';
import { PermanentProcessingError, type VideoProcessor } from '../processor.js';
import { CommandError, runCommand, type RunOptions } from './command.js';
import { buildMasterPlaylist, buildRenditionArgs, selectLadder, type Rung } from './ladder.js';
import { probeFile, type ProbeResult } from './probe.js';
import { loadProcessingConfig, type ProcessingConfig } from './processingConfig.js';

const IMMUTABLE = 'public, max-age=31536000, immutable'; // segments never change
const SHORT = 'public, max-age=60'; // playlists might
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

// Errors that mean "this file is broken", so retrying cannot help.
const BROKEN_FILE_PATTERNS = [/Invalid data found when processing input/i, /moov atom not found/i];

function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Processing was stopped');
}

function describeFile(name: string): { type: string; cache: string } {
  if (name.endsWith('.ts')) return { type: 'video/mp2t', cache: IMMUTABLE };
  if (name.endsWith('.m3u8')) return { type: PLAYLIST_TYPE, cache: SHORT };
  if (name.endsWith('.jpg')) return { type: 'image/jpeg', cache: SHORT };
  return { type: 'application/octet-stream', cache: SHORT };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failed = true; // tell the other workers to stop picking up new files
        throw err;
      }
    }
  });
  await Promise.all(workers);
}

export async function assertMediaToolsAvailable(
  config: ProcessingConfig = loadProcessingConfig(),
): Promise<void> {
  const options: RunOptions = { signal: new AbortController().signal, timeoutMs: 15_000 };
  await runCommand(config.ffmpegPath, ['-version'], options);
  await runCommand(config.ffprobePath, ['-version'], options);
}

export class FfmpegProcessor implements VideoProcessor {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: ProcessingConfig = loadProcessingConfig(),
  ) {}

  async process(video: VideoRecord, signal: AbortSignal): Promise<void> {
    const { config } = this;
    const deadline = Date.now() + config.jobTimeoutMs;
    const run = (): RunOptions => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Processing exceeded the time limit');
      return { signal, timeoutMs: remaining };
    };

    const workDir = await mkdtemp(path.join(os.tmpdir(), 'cineai-'));
    try {
      const source = path.join(workDir, 'source');
      await this.download(video.id, source, signal);

      const probe = await probeFile(source, config, run());
      const rungs = selectLadder(probe);

      for (const rung of rungs) {
        const outDir = path.join(workDir, 'out', rung.name);
        await mkdir(outDir, { recursive: true });
        await this.transcode(source, outDir, rung, probe.hasAudio, run());
      }

      await this.makePoster(source, path.join(workDir, 'out', 'poster.jpg'), probe, run());
      await this.publish(video.id, path.join(workDir, 'out'), rungs, signal);

      console.log(
        `video ${video.id}: ${rungs.map((r) => r.name).join(', ')} (${Math.round(probe.durationSeconds)}s source)`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async download(videoId: string, destination: string, signal: AbortSignal): Promise<void> {
    stopIfAborted(signal);
    try {
      await this.storage.downloadToFile(masterKey(videoId), destination);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        throw new PermanentProcessingError('The original upload is missing from storage; please upload again');
      }
      throw err;
    }
    stopIfAborted(signal);
  }

  private async transcode(
    source: string,
    outDir: string,
    rung: Rung,
    hasAudio: boolean,
    options: RunOptions,
  ): Promise<void> {
    try {
      await runCommand(
        this.config.ffmpegPath,
        buildRenditionArgs(source, outDir, rung, hasAudio, this.config),
        options,
      );
    } catch (err) {
      if (err instanceof CommandError) {
        if (BROKEN_FILE_PATTERNS.some((p) => p.test(err.stderr))) {
          throw new PermanentProcessingError('The video data is corrupted and cannot be converted');
        }
        const detail = err.stderr.trim().split('\n').slice(-3).join(' | ');
        throw new Error(`Transcoding ${rung.name} failed: ${detail}`);
      }
      throw err;
    }
  }

  // A missing poster is a nuisance, not a reason to fail the whole video.
  private async makePoster(
    source: string,
    destination: string,
    probe: ProbeResult,
    options: RunOptions,
  ): Promise<void> {
    const at = Math.min(2, probe.durationSeconds / 2).toFixed(2);
    try {
      await runCommand(
        this.config.ffmpegPath,
        ['-y', '-loglevel', 'error', '-ss', at, '-i', source, '-frames:v', '1',
         '-vf', "scale=-2:'min(480,ih)'", '-q:v', '3', destination],
        options,
      );
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      console.warn('poster could not be created; continuing without one');
    }
  }

  private async publish(
    videoId: string,
    outRoot: string,
    rungs: Rung[],
    signal: AbortSignal,
  ): Promise<void> {
    const files: { key: string; filePath: string; type: string; cache: string }[] = [];

    for (const rung of rungs) {
      const dir = path.join(outRoot, rung.name);
      for (const name of await readdir(dir)) {
        files.push({
          key: `${hlsPrefix(videoId)}/${rung.name}/${name}`,
          filePath: path.join(dir, name),
          ...describeFile(name),
        });
      }
    }

    const poster = path.join(outRoot, 'poster.jpg');
    if (await access(poster).then(() => true, () => false)) {
      files.push({ key: `${hlsPrefix(videoId)}/poster.jpg`, filePath: poster, ...describeFile('poster.jpg') });
    }

    await mapLimit(files, this.config.uploadConcurrency, async (f) => {
      stopIfAborted(signal);
      await this.storage.putObject(f.key, await readFile(f.filePath), f.type, f.cache);
    });

    // Last on purpose: until this exists, nothing can start playing.
    stopIfAborted(signal);
    await this.storage.putObject(
      masterManifestKey(videoId),
      Buffer.from(buildMasterPlaylist(rungs, this.config.fps)),
      PLAYLIST_TYPE,
      SHORT,
    );
  }
}