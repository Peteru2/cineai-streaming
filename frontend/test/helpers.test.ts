import { describe, test, expect } from 'vitest';
import { formatDate, titleFromFilename } from '../src/files';

describe('titleFromFilename', () => {
  test('removes the extension and turns underscores into spaces', () => {
    expect(titleFromFilename('my_pilot_v2.mp4')).toBe('my pilot v2');
    expect(titleFromFilename('Holiday.MOV')).toBe('Holiday');
    expect(titleFromFilename('a.b.mp4')).toBe('a.b');
  });
  test('keeps names without an extension and never returns an empty title', () => {
    expect(titleFromFilename('noextension')).toBe('noextension');
    expect(titleFromFilename('.mp4')).toBe('Untitled');
    expect(titleFromFilename('')).toBe('Untitled');
  });
});

describe('formatDate', () => {
  test('formats a valid date and survives an invalid one', () => {
    expect(formatDate('2026-03-05T10:00:00Z')).toContain('2026');
    expect(formatDate('not a date')).toBe('');
  });
});