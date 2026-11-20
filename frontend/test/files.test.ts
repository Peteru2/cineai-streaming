import { describe, test, expect } from 'vitest';
import { contentTypeOf, formatBytes, percent } from '../src/files';

describe('contentTypeOf', () => {
  test('accepts supported MIME types as given', () => {
    expect(contentTypeOf('x', 'video/mp4')).toBe('video/mp4');
  });
  test('falls back to the extension when the browser gives no type', () => {
    expect(contentTypeOf('Holiday.MOV', '')).toBe('video/quicktime');
    expect(contentTypeOf('clip.mkv', 'application/octet-stream')).toBe('video/x-matroska');
  });
  test('rejects other files, including ones without an extension', () => {
    expect(contentTypeOf('notes.pdf', 'application/pdf')).toBeNull();
    expect(contentTypeOf('README', '')).toBeNull();
  });
});

describe('formatBytes and percent', () => {
  test('formats sizes', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB');
  });
  test('percent is bounded and safe for an empty file', () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(0, 0)).toBe(0);
  });
});