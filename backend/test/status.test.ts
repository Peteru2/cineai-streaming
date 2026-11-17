import { describe, test, expect } from 'vitest';
import {
  VIDEO_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  isTerminal,
  InvalidTransitionError,
  type VideoStatus,
} from '../src/domain/status.js';

const legal: [VideoStatus, VideoStatus][] = [
  ['uploading', 'uploaded'],
  ['uploading', 'abandoned'],
  ['uploaded', 'queued'],
  ['uploaded', 'failed'],
  ['queued', 'processing'],
  ['processing', 'ready'],
  ['processing', 'failed'],
  ['processing', 'queued'],
];

const illegal: [VideoStatus, VideoStatus][] = [
  ['uploading', 'ready'],
  ['uploading', 'processing'],
  ['uploading', 'uploading'],
  ['uploaded', 'ready'],
  ['queued', 'ready'],
  ['ready', 'processing'],
  ['ready', 'failed'],
  ['failed', 'queued'],
  ['abandoned', 'uploaded'],
];

describe('status rulebook', () => {
  test.each(legal)('%s -> %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  test.each(illegal)('%s -> %s is rejected', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  test('the legal list covers every rule in the table', () => {
    const total = VIDEO_STATUSES.reduce((n, s) => n + ALLOWED_TRANSITIONS[s].length, 0);
    expect(legal).toHaveLength(total);
  });

  test('ready, failed and abandoned are terminal', () => {
    expect(isTerminal('ready')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('abandoned')).toBe(true);
    expect(isTerminal('processing')).toBe(false);
  });

  test('no limbo: every status can reach a terminal status', () => {
    for (const start of VIDEO_STATUSES) {
      const seen = new Set<VideoStatus>([start]);
      const pending: VideoStatus[] = [start];
      let found = isTerminal(start);

      while (pending.length > 0 && !found) {
        const current = pending.shift() as VideoStatus;
        for (const next of ALLOWED_TRANSITIONS[current]) {
          if (isTerminal(next)) {
            found = true;
            break;
          }
          if (!seen.has(next)) {
            seen.add(next);
            pending.push(next);
          }
        }
      }
      expect(found, `${start} can get stuck`).toBe(true);
    }
  });
});