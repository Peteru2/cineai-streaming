export interface PartPlan {
  partNumber: number;
  offset: number;
  size: number;
  url: string;
}

export interface UploadPlan {
  partSizeBytes: number;
  totalParts: number;
  uploadedParts: { partNumber: number; size: number }[];
  missingParts: PartPlan[];
  urlsExpireInSeconds: number;
}

export class PartError extends Error {
  constructor(
    /** HTTP status, or null for network failures. */
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'PartError';
  }
}

export interface UploadDeps {
  putPart(
    url: string,
    body: Blob,
    onProgress: (loadedBytes: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Asks the API what storage has, and for fresh signed URLs for the rest. */
  refreshPlan(): Promise<UploadPlan>;
  sleep(ms: number): Promise<void>;
  /** Optional. While this returns true, failures do not use up attempts. */
  isOffline?(): boolean;
}

export interface UploadOptions {
  concurrency?: number;
  maxAttempts?: number;
  onProgress?: (bytesDone: number) => void;
  onEvent?: (message: string) => void;
  signal?: AbortSignal;
}

const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 15_000);

export async function uploadParts(
  file: Blob,
  initialPlan: UploadPlan,
  deps: UploadDeps,
  options: UploadOptions = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 3;
  const maxAttempts = options.maxAttempts ?? 8;
  const signal = options.signal ?? new AbortController().signal;
  const emit = options.onEvent ?? (() => {});

  let plan = initialPlan;
  const originalSizes = new Map(initialPlan.missingParts.map((p) => [p.partNumber, p.size]));
  const alreadyStored = initialPlan.uploadedParts.reduce((sum, p) => sum + p.size, 0);
  const loaded = new Map<number, number>();

  const report = () => {
    let total = alreadyStored;
    for (const bytes of loaded.values()) total += bytes;
    options.onProgress?.(total);
  };
  report();

  // Several parts may need new URLs at once; refresh only once for all of them.
  let refreshing: Promise<void> | null = null;
  const refresh = () => {
    refreshing ??= deps
      .refreshPlan()
      .then((fresh) => {
        plan = fresh;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  async function uploadOne(partNumber: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new Error('Upload cancelled');

      const current = plan.missingParts.find((p) => p.partNumber === partNumber);
      if (!current) {
        // Storage already has it (it arrived before we last asked).
        loaded.set(partNumber, originalSizes.get(partNumber) ?? 0);
        report();
        return;
      }

      try {
        await deps.putPart(
          current.url,
          file.slice(current.offset, current.offset + current.size),
          (bytes) => {
            loaded.set(partNumber, bytes);
            report();
          },
          signal,
        );
        loaded.set(partNumber, current.size);
        report();
        return;
      } catch (err) {
        loaded.set(partNumber, 0);
        report();
        if (signal.aborted) throw new Error('Upload cancelled');

        if (deps.isOffline?.()) {
          attempt--; // being offline is not the part's fault
          emit('You are offline. Waiting for the connection...');
          await deps.sleep(1000);
          continue;
        }

        if (attempt >= maxAttempts) throw err;

        const expired = err instanceof PartError && err.status === 403;
        emit(
          expired
            ? `Part ${partNumber}: the upload link expired. Asking for a new one...`
            : `Part ${partNumber} failed (attempt ${attempt} of ${maxAttempts}). Retrying...`,
        );
        if (expired) {
          try {
            await refresh();
          } catch {
            await deps.sleep(backoffMs(attempt));
          }
        } else {
          await deps.sleep(backoffMs(attempt));
        }
      }
    }
  }

  const queue = initialPlan.missingParts.map((p) => p.partNumber);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (!failed && next < queue.length) {
      const partNumber = queue[next++] as number;
      try {
        await uploadOne(partNumber);
      } catch (err) {
        failed = true; // stop the other lanes from starting new parts
        throw err;
      }
    }
  });
  await Promise.all(lanes);
}