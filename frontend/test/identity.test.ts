import { describe, test, expect } from 'vitest';
import { remembered, uploadKeyFor } from '../src/identity';

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('remembered', () => {
  test('returns the same value every time', () => {
    const storage = fakeStorage();
    const first = remembered('k', () => 'a', storage);
    expect(remembered('k', () => 'b', storage)).toBe(first);
  });

  test('still works when storage is unavailable', () => {
    expect(remembered('k', () => 'a', null)).toBe('a');
  });

  test('still works when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(remembered('k', () => 'a', broken)).toBe('a');
  });
});

describe('uploadKeyFor', () => {
  test('the same file gets the same key, a different file a different one', () => {
    const storage = fakeStorage();
    const file = { name: 'a.mp4', size: 100, lastModified: 1 };
    const key = uploadKeyFor(file, storage);
    expect(uploadKeyFor({ ...file }, storage)).toBe(key);
    expect(uploadKeyFor({ ...file, size: 101 }, storage)).not.toBe(key);
    expect(uploadKeyFor({ ...file, lastModified: 2 }, storage)).not.toBe(key);
  });
});