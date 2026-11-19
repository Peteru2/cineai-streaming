import type { PostgresVideoStore } from '../db/postgresVideoStore.js';
import type { JobQueue } from '../queue/jobQueue.js';
import type { ObjectStorage } from '../storage/objectStorage.js';
import { masterKey } from '../storage/keys.js';
import { transitionVideo } from '../domain/transition.js';
import { enqueueUploadedVideo } from './enqueue.js';

export interface WatchdogConfig {
  stallSeconds: number; // no heartbeat for this long = worker presumed dead
  maxAttempts: number; // must match the worker's limit
  uploadedGraceSeconds: number; // `uploaded` this long without a ticket = dropped hand-off
  queuedGraceSeconds: number; // `queued` this long = ticket may be lost (must exceed the retry delay)
  reconcileAfterSeconds: number; // start checking storage for lost completions after this
  abandonAfterSeconds: number; // an unfinished upload is abandoned after this
  intervalMs: number;
  batchSize: number;
}

export function loadWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  return {
    stallSeconds: Number(env.WATCHDOG_STALL_SECONDS ?? 120),
    maxAttempts: Number(env.WORKER_MAX_ATTEMPTS ?? 3),
    uploadedGraceSeconds: Number(env.WATCHDOG_UPLOADED_GRACE_SECONDS ?? 60),
    queuedGraceSeconds: Number(env.WATCHDOG_QUEUED_GRACE_SECONDS ?? 300),
    reconcileAfterSeconds: Number(env.WATCHDOG_RECONCILE_AFTER_SECONDS ?? 300),
    abandonAfterSeconds: Number(env.WATCHDOG_ABANDON_AFTER_SECONDS ?? 24 * 3600),
    intervalMs: Number(env.WATCHDOG_INTERVAL_MS ?? 60_000),
    batchSize: Number(env.WATCHDOG_BATCH_SIZE ?? 100),
  };
}

export interface WatchdogDeps {
  store: PostgresVideoStore;
  storage: ObjectStorage;
  queue: JobQueue;
  config: WatchdogConfig;
}

export interface WatchdogReport {
  stalledRequeued: number;
  stalledFailed: number;
  lostCompletionsRecovered: number;
  uploadsAbandoned: number;
  uploadedQueued: number;
  queuedReticketed: number;
  errors: number;
}

// One broken video must never stop the scan of the others.
async function eachSafely<T extends { id: string }>(
  items: T[],
  report: WatchdogReport,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      report.errors++;
      console.error(`watchdog: video ${item.id} could not be handled`, err);
    }
  }
}

export async function runWatchdogOnce(deps: WatchdogDeps): Promise<WatchdogReport> {
  const { store, storage, queue, config } = deps;
  const report: WatchdogReport = {
    stalledRequeued: 0,
    stalledFailed: 0,
    lostCompletionsRecovered: 0,
    uploadsAbandoned: 0,
    uploadedQueued: 0,
    queuedReticketed: 0,
    errors: 0,
  };

  // 1. Workers that went quiet while processing (F7, F8).
  const stalled = await store.findStalledProcessing(config.stallSeconds, config.batchSize);
  await eachSafely(stalled, report, async (s) => {
    if (s.attempts >= config.maxAttempts) {
      const reason = `Processing stalled on attempt ${s.attempts} and no attempts are left`;
      if (await store.expireStalled(s.id, s.attempts, config.stallSeconds, 'failed', reason)) {
        report.stalledFailed++;
      }
      return;
    }
    const reason = `Worker stopped responding on attempt ${s.attempts}`;
    if (await store.expireStalled(s.id, s.attempts, config.stallSeconds, 'queued', reason)) {
      report.stalledRequeued++;
      await queue.enqueue(s.id, s.attempts + 1); // if this fails, step 4 re-issues the ticket
    }
  });

  // 2. Uploads that are still `uploading`: lost completions (F4) and abandoned ones (F3).
  const waiting = await store.findStale('uploading', config.reconcileAfterSeconds, config.batchSize);
  const abandonable = new Set(
    (await store.findStale('uploading', config.abandonAfterSeconds, config.batchSize)).map((v) => v.id),
  );
  await eachSafely(waiting, report, async (v) => {
    const key = masterKey(v.id);

    if (await storage.objectExists(key)) {
      // The file is complete in storage but the status never moved.
      if ((await transitionVideo(store, v.id, 'uploading', 'uploaded')) === 'applied') {
        report.lostCompletionsRecovered++;
        await enqueueUploadedVideo(store, queue, v.id);
      }
      return;
    }

    if (abandonable.has(v.id)) {
      const hours = Math.round(config.abandonAfterSeconds / 3600);
      const won = await store.compareAndSetStatus(
        v.id,
        'uploading',
        'abandoned',
        `Upload not finished within ${hours} hours`,
      );
      if (won) {
        report.uploadsAbandoned++;
        if (v.uploadId) {
          // Status is already final. If this fails, a bucket lifecycle rule is the backstop.
          await storage.abortMultipartUpload(key, v.uploadId).catch((err) => {
            console.error(`watchdog: could not abort upload for ${v.id}`, err);
          });
        }
      }
    }
  });

  // 3. `uploaded` videos that never got a ticket (the API's hand-off was dropped).
  const uploaded = await store.findStale('uploaded', config.uploadedGraceSeconds, config.batchSize);
  await eachSafely(uploaded, report, async (v) => {
    if ((await enqueueUploadedVideo(store, queue, v.id)) === 'applied') report.uploadedQueued++;
  });

  // 4. `queued` videos whose ticket may be lost. Re-issuing is safe: the same
  //    ticket ID is ignored by the queue, and a worker's claim is atomic anyway.
  const queued = await store.findStale('queued', config.queuedGraceSeconds, config.batchSize);
  await eachSafely(queued, report, async (v) => {
    await queue.enqueue(v.id, v.attempts + 1);
    report.queuedReticketed++;
  });

  return report;
}

export function startWatchdog(deps: WatchdogDeps): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = () => {
    running = (async () => {
      try {
        const report = await runWatchdogOnce(deps);
        const total = Object.values(report).reduce((a, b) => a + b, 0);
        if (total > 0) console.log('watchdog:', JSON.stringify(report));
      } catch (err) {
        console.error('watchdog run failed', err);
      }
      if (!stopped) timer = setTimeout(tick, deps.config.intervalMs);
    })();
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}