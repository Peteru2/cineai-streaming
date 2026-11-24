import { describe, test, expect } from 'vitest';
import { GENERIC_FAILURE, friendlyFailure } from '../src/messages';

describe('friendlyFailure', () => {
  test.each([
    ['The file has no video track', /couldn't find a video/],
    ['The file could not be read as a video', /couldn't find a video/],
    ['The video data is corrupted and cannot be converted', /damaged/],
    ['The video is longer than 60 minutes', /shorter cut/],
    ['The video is taller than 4320 pixels', /4K or lower/],
    ['The original upload is missing from storage; please upload again', /didn't finish/],
    ['Upload not finished within 24 hours', /didn't finish/],
    ['Gave up after 3 attempts: Transcoding 720p failed', /several tries/],
    ['Processing stalled on attempt 3 and no attempts are left', /several tries/],
  ])('%s', (reason, expected) => {
    expect(friendlyFailure(reason)).toMatch(expected);
  });

  test('anything unknown, empty or missing gets a safe generic message', () => {
    expect(friendlyFailure('ffmpeg: weird codec error 0x1234')).toBe(GENERIC_FAILURE);
    expect(friendlyFailure('')).toBe(GENERIC_FAILURE);
    expect(friendlyFailure(null)).toBe(GENERIC_FAILURE);
  });

  test('friendly messages never expose technical details', () => {
    const message = friendlyFailure('Gave up after 3 attempts: Transcoding 720p failed: ffmpeg exited with code 1');
    expect(message).not.toMatch(/ffmpeg|exited|code 1/i);
  });
});