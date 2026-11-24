import { describe, test, expect } from 'vitest';
import { initialState, reducer, type Action, type UploadState } from '../src/uploadState';

const apply = (state: UploadState, ...actions: Action[]) => actions.reduce(reducer, state);

describe('server status and resume notice', () => {
  test('the server status is remembered', () => {
    const state = apply(initialState, { type: 'serverStatus', status: 'queued' });
    expect(state.serverStatus).toBe('queued');
  });

  test('failed and abandoned never replace the last in-progress status', () => {
    const state = apply(
      initialState,
      { type: 'serverStatus', status: 'processing' },
      { type: 'serverStatus', status: 'failed' },
      { type: 'serverStatus', status: 'abandoned' },
    );
    expect(state.serverStatus).toBe('processing');
  });

  test('starting a new upload clears both', () => {
    const state = apply(
      initialState,
      { type: 'serverStatus', status: 'processing' },
      { type: 'resumed', stored: 3, total: 10 },
      { type: 'begin', totalBytes: 100 },
    );
    expect(state.serverStatus).toBeNull();
    expect(state.resumed).toBeNull();
  });

  test('a resumed upload records how much was already safe', () => {
    const state = apply(initialState, { type: 'resumed', stored: 3, total: 10 });
    expect(state.resumed).toEqual({ stored: 3, total: 10 });
  });
});