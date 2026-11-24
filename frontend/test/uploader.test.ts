import { describe, test, expect } from 'vitest';
import { PartError, uploadParts, type UploadDeps, type UploadPlan } from '../src/uploader';

const MB = 1024 * 1024;

function planFor(totalParts: number, stored: number[] = [], urlPrefix = 'u1'): UploadPlan {
  const parts = Array.from({ length: totalParts }, (_, i) => i + 1);
  return {
    partSizeBytes: 5 * MB,
    totalParts,
    uploadedParts: stored.map((n) => ({ partNumber: n, size: 5 * MB })),
    missingParts: parts
      .filter((n) => !stored.includes(n))
      .map((n) => ({
        partNumber: n,
        offset: (n - 1) * 5 * MB,
        size: 5 * MB,
        url: `${urlPrefix}/part${n}`,
      })),
    urlsExpireInSeconds: 3600,
  };
}

const file = new Blob([new Uint8Array(1)]); // slices are never read by the fake network

function makeDeps(overrides: Partial<UploadDeps> = {}) {
  const calls: string[] = [];
  const deps: UploadDeps = {
    putPart: async (url, _body, onProgress) => {
      calls.push(url);
      onProgress(5 * MB);
    },
    refreshPlan: async () => planFor(0),
    sleep: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe('uploadParts', () => {
  test('uploads every missing part and reports full progress', async () => {
    const { deps, calls } = makeDeps();
    let last = 0;
    await uploadParts(file, planFor(3), deps, { onProgress: (b) => (last = b) });
    expect(calls.sort()).toEqual(['u1/part1', 'u1/part2', 'u1/part3']);
    expect(last).toBe(15 * MB);
  });

  test('a resumed upload sends only the missing parts and counts stored bytes', async () => {
    const { deps, calls } = makeDeps();
    let first = -1;
    await uploadParts(file, planFor(4, [1, 2]), deps, {
      onProgress: (b) => {
        if (first < 0) first = b;
      },
    });
    expect(calls.sort()).toEqual(['u1/part3', 'u1/part4']);
    expect(first).toBe(10 * MB); // progress starts where the last upload stopped
  });

  test('a failed part is retried and then succeeds', async () => {
    let failures = 0;
    const { deps, calls } = makeDeps({
      putPart: async (url, _b, onProgress) => {
        calls.push(url);
        if (failures++ < 2) throw new PartError(null, 'Network error');
        onProgress(5 * MB);
      },
    });
    await uploadParts(file, planFor(1), deps, { concurrency: 1 });
    expect(calls).toEqual(['u1/part1', 'u1/part1', 'u1/part1']);
  });

  test('an expired link (403) triggers a refresh and the retry uses the new URL', async () => {
    let refreshes = 0;
    const { deps, calls } = makeDeps({
      putPart: async (url, _b, onProgress) => {
        calls.push(url);
        if (url.startsWith('u1/')) throw new PartError(403, 'Forbidden');
        onProgress(5 * MB);
      },
      refreshPlan: async () => {
        refreshes++;
        return planFor(2, [], 'u2');
      },
    });
    await uploadParts(file, planFor(2), deps, { concurrency: 2 });
    expect(refreshes).toBe(1); // both parts expired together, one refresh served both
    expect(calls.filter((u) => u.startsWith('u2/')).sort()).toEqual(['u2/part1', 'u2/part2']);
  });

  test('a part that storage already has after a refresh is not sent again', async () => {
    const { deps, calls } = makeDeps({
      putPart: async (url, _b, onProgress) => {
        calls.push(url);
        if (url === 'u1/part1') throw new PartError(403, 'Forbidden');
        onProgress(5 * MB);
      },
      refreshPlan: async () => planFor(2, [1], 'u2'), // part 1 actually arrived
    });
    let last = 0;
    await uploadParts(file, planFor(2), deps, { concurrency: 1, onProgress: (b) => (last = b) });

    // Part 1 is tried once and never again. Part 2 uses the fresh link, not the stale one.
    expect(calls).toEqual(['u1/part1', 'u2/part2']);
    expect(last).toBe(10 * MB);
  });

  test('it gives up after the maximum number of attempts', async () => {
    const { deps, calls } = makeDeps({
      putPart: async (url) => {
        calls.push(url);
        throw new PartError(500, 'Storage error');
      },
    });
    await expect(uploadParts(file, planFor(1), deps, { maxAttempts: 3 })).rejects.toThrow('Storage error');
    expect(calls).toHaveLength(3);
  });

  test('failures while offline do not use up attempts', async () => {
    let offline = true;
    let tries = 0;
    const { deps, calls } = makeDeps({
      isOffline: () => offline,
      putPart: async (url, _b, onProgress) => {
        calls.push(url);
        tries++;
        if (offline) throw new PartError(null, 'Network error');
        onProgress(5 * MB);
      },
      sleep: async () => {
        if (tries >= 15) offline = false;
      },
    });
    await uploadParts(file, planFor(1), deps, { maxAttempts: 3, concurrency: 1 });
    expect(calls.length).toBeGreaterThan(3);
  });

  test('cancelling stops the upload', async () => {
    const controller = new AbortController();
    const { deps } = makeDeps({
      putPart: async () => {
        controller.abort();
        throw new PartError(null, 'aborted');
      },
    });
    await expect(
      uploadParts(file, planFor(2), deps, { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});