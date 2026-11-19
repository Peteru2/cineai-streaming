import { describe, test, expect } from 'vitest';
import { parseProbe, validateProbe } from '../src/worker/media/probe.js';
import { buildMasterPlaylist, buildRenditionArgs, selectLadder } from '../src/worker/media/ladder.js';
import { loadProcessingConfig } from '../src/worker/media/processingConfig.js';
import { PermanentProcessingError } from '../src/worker/processor.js';

const config = loadProcessingConfig({});
const probe = (width: number, height: number) => ({
  durationSeconds: 10,
  width,
  height,
  hasAudio: true,
  videoCodec: 'h264',
});

describe('parseProbe', () => {
  test('reads the facts we need from ffprobe output', () => {
    const result = parseProbe({
      format: { duration: '12.5' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(result).toEqual({
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      hasAudio: true,
      videoCodec: 'h264',
    });
  });

  test('a file with no video track is a permanent error', () => {
    expect(() =>
      parseProbe({ format: { duration: '3' }, streams: [{ codec_type: 'audio' }] }),
    ).toThrow(PermanentProcessingError);
  });

  test('cover art does not count as a video track', () => {
    expect(() =>
      parseProbe({
        format: { duration: '3' },
        streams: [{ codec_type: 'video', width: 500, height: 500, disposition: { attached_pic: 1 } }],
      }),
    ).toThrow(PermanentProcessingError);
  });

  test('garbage input is a permanent error', () => {
    expect(() => parseProbe(null)).toThrow(PermanentProcessingError);
    expect(() => parseProbe({ streams: [{ codec_type: 'video', width: 0, height: 0 }] })).toThrow(
      PermanentProcessingError,
    );
  });
});

describe('validateProbe', () => {
  test('accepts a normal video', () => {
    expect(() => validateProbe(probe(1920, 1080), config)).not.toThrow();
  });

  test('rejects a video that is too long or too tall', () => {
    expect(() =>
      validateProbe({ ...probe(1920, 1080), durationSeconds: 3601 }, config),
    ).toThrow(PermanentProcessingError);
    expect(() => validateProbe(probe(8000, 5000), config)).toThrow(PermanentProcessingError);
  });
});

describe('selectLadder', () => {
  test('a 1080p source gets four rungs, widest first', () => {
    const rungs = selectLadder(probe(1920, 1080));
    expect(rungs.map((r) => r.name)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(rungs[1]).toMatchObject({ width: 1280, height: 720 });
  });

  test('never upscales: a 720p source gets no 1080p', () => {
    expect(selectLadder(probe(1280, 720)).map((r) => r.name)).toEqual(['720p', '480p', '360p']);
  });

  test('a source smaller than every rung keeps its own size', () => {
    const rungs = selectLadder(probe(320, 240));
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatchObject({ name: '240p', width: 320, height: 240 });
  });
});

describe('buildMasterPlaylist', () => {
  test('lists every rung, lowest quality first', () => {
    const text = buildMasterPlaylist(selectLadder(probe(1280, 720)), 30);
    const variants = text.split('\n').filter((l) => l.endsWith('/index.m3u8'));
    expect(variants).toEqual(['360p/index.m3u8', '480p/index.m3u8', '720p/index.m3u8']);
    expect(text).toContain('#EXTM3U');
    expect(text).toContain('RESOLUTION=640x360');
    expect(text).toContain('BANDWIDTH=845000');
  });
});

describe('buildRenditionArgs', () => {
  const rung = selectLadder(probe(1920, 1080))[1]!; // 720p
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  test('forces constant frame rate and aligned keyframes (the sync and switching fixes)', () => {
    const args = buildRenditionArgs('in', 'out', rung, true, config);
    expect(value(args, '-vf')).toContain('fps=30');
    expect(value(args, '-vf')).toContain('scale=-2:720');
    expect(value(args, '-g')).toBe('120'); // 30 fps x 4 seconds
    expect(value(args, '-keyint_min')).toBe('120');
    expect(value(args, '-sc_threshold')).toBe('0');
    expect(value(args, '-af')).toBe('aresample=async=1:first_pts=0');
  });

  test('a video without audio gets no audio options', () => {
    const args = buildRenditionArgs('in', 'out', rung, false, config);
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('-map\u0000a');
  });
});