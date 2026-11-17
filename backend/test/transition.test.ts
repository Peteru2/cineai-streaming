import { describe, test, expect } from 'vitest';
import { transitionVideo } from '../src/domain/transition.js';
import { InvalidTransitionError } from '../src/domain/status.js';
import { MemoryVideoStore } from './helpers/memoryStore.js';

describe('transitionVideo', () => {
  test('applies a legal transition', async () => {
    const store = new MemoryVideoStore({ v1: 'uploading' });
    expect(await transitionVideo(store, 'v1', 'uploading', 'uploaded')).toBe('applied');
    expect(store.get('v1')).toBe('uploaded');
  });

  test('five simultaneous "complete" signals apply exactly once', async () => {
    const store = new MemoryVideoStore({ v1: 'uploading' });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => transitionVideo(store, 'v1', 'uploading', 'uploaded')),
    );

    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'lost_race')).toHaveLength(4);
    expect(store.get('v1')).toBe('uploaded');
  });

  test('a stale expectation loses the race and changes nothing', async () => {
    const store = new MemoryVideoStore({ v1: 'queued' });
    expect(await transitionVideo(store, 'v1', 'uploading', 'uploaded')).toBe('lost_race');
    expect(store.get('v1')).toBe('queued');
  });

  test('an illegal transition throws and changes nothing', async () => {
    const store = new MemoryVideoStore({ v1: 'uploading' });
    await expect(transitionVideo(store, 'v1', 'uploading', 'ready')).rejects.toThrow(
      InvalidTransitionError,
    );
    expect(store.get('v1')).toBe('uploading');
  });
});