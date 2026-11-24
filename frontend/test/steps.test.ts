import { describe, test, expect } from 'vitest';
import { stepStates } from '../src/steps';

describe('stepStates', () => {
  test('nothing has started while idle', () => {
    expect(stepStates('idle', null)).toEqual(['todo', 'todo', 'todo', 'todo']);
  });

  test('uploading keeps step one active until the upload is complete', () => {
    for (const phase of ['starting', 'uploading', 'finishing'] as const) {
      expect(stepStates(phase, null)).toEqual(['active', 'todo', 'todo', 'todo']);
    }
  });

  test('the server status decides between queued and processing', () => {
    expect(stepStates('processing', null)).toEqual(['done', 'active', 'todo', 'todo']);
    expect(stepStates('processing', 'queued')).toEqual(['done', 'active', 'todo', 'todo']);
    expect(stepStates('processing', 'processing')).toEqual(['done', 'done', 'active', 'todo']);
  });

  test('ready completes every step', () => {
    expect(stepStates('ready', 'ready')).toEqual(['done', 'done', 'done', 'done']);
  });

  test('a failure marks the step where it happened', () => {
    expect(stepStates('failed', null)).toEqual(['failed', 'todo', 'todo', 'todo']);
    expect(stepStates('failed', 'queued')).toEqual(['done', 'failed', 'todo', 'todo']);
    expect(stepStates('failed', 'processing')).toEqual(['done', 'done', 'failed', 'todo']);
    expect(stepStates('failed', 'ready')).toEqual(['done', 'done', 'done', 'failed']);
  });
});