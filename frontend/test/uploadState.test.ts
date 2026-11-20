import { describe, test, expect } from 'vitest';
import { initialState, isBusy, reducer, type UploadState } from '../src/uploadState';

const apply = (state: UploadState, ...actions: Parameters<typeof reducer>[1][]) =>
  actions.reduce(reducer, state);

describe('upload state', () => {
  test('a normal run moves through the phases', () => {
    let state = apply(initialState, { type: 'begin', totalBytes: 100 });
    expect(state.phase).toBe('starting');

    state = apply(state, { type: 'progress', bytes: 40 });
    expect(state).toMatchObject({ phase: 'uploading', progressBytes: 40 });

    state = apply(state, { type: 'phase', phase: 'finishing', message: 'Finishing' });
    state = apply(state, {
      type: 'ready',
      playback: { id: 'v', filename: 'f', manifestUrl: 'm', posterUrl: 'p' },
    });
    expect(state.phase).toBe('ready');
    expect(state.playback?.id).toBe('v');
  });

  test('a late progress event cannot pull a finished upload back to uploading', () => {
    const state = apply(
      initialState,
      { type: 'begin', totalBytes: 100 },
      { type: 'phase', phase: 'processing', message: 'Processing' },
      { type: 'progress', bytes: 99 },
    );
    expect(state.phase).toBe('processing');
    expect(state.progressBytes).toBe(0);
  });

  test('starting again clears the previous result but keeps the log', () => {
    let state = apply(
      initialState,
      { type: 'log', message: 'hello', at: 1 },
      { type: 'failed', message: 'boom' },
    );
    state = apply(state, { type: 'begin', totalBytes: 10 });
    expect(state.phase).toBe('starting');
    expect(state.log).toHaveLength(1);
  });

  test('log entries are newest first, uniquely numbered, and capped', () => {
    let state = initialState;
    for (let i = 0; i < 250; i++) state = apply(state, { type: 'log', message: `m${i}`, at: i });
    expect(state.log).toHaveLength(200);
    expect(state.log[0]?.message).toBe('m249');
    expect(new Set(state.log.map((e) => e.id)).size).toBe(200);
  });

  test('cancelling returns to idle with a hint about resuming', () => {
    const state = apply(initialState, { type: 'begin', totalBytes: 10 }, { type: 'cancelled' });
    expect(state.phase).toBe('idle');
    expect(state.message).toContain('resume');
  });

  test('isBusy covers exactly the in-progress phases', () => {
    expect(['starting', 'uploading', 'finishing', 'processing'].every((p) => isBusy(p as never))).toBe(true);
    expect(['idle', 'ready', 'failed'].some((p) => isBusy(p as never))).toBe(false);
  });
});