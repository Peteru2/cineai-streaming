import type { PostgresVideoStore } from '../db/postgresVideoStore.js';
import type { JobQueue } from '../queue/jobQueue.js';
import { PermanentProcessingError, type VideoProcessor } from './processor.js';

export interface WorkerConfig {
  maxAttempts: number;
  heartbeatMs: number;
  retryDelayMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    maxAttempts: Number(env.WORKER_MAX_ATTEMPTS ?? 3),
    heartbeatMs: Number(env.WORKER_HEARTBEAT_MS ?? 30_000),
    retryDelayMs: Number(env.WORKER_RETRY_DELAY_MS ?? 5_000),
  };
}

export interface ProcessDeps {
  store: PostgresVideoStore;
  queue: JobQueue;
  processor: VideoProcessor;
  config: WorkerConfig;
}

export type ProcessOutcome = 'skipped' | 'ready' | 'retry_scheduled' | 'failed' | 'lost';

export async function processVideo(deps: ProcessDeps, videoId: string): Promise<ProcessOutcome> {
  const { store, queue, processor, config } = deps;

  // Step 1: claim. If another worker got there first, or the ticket is stale, do nothing.
  const video = await store.claimForProcessing(videoId);
  if (!video) return 'skipped';

  const attempt = video.attempts; // our lease token
  const controller = new AbortController();
  let leaseLost = false;

  // Step 2: heartbeat. If it ever fails, someone else owns the video now: stop.
  const timer = setInterval(() => {
    store
      .heartbeat(videoId, attempt)
      .then((stillOurs) => {
        if (!stillOurs) {
          leaseLost = true;
          controller.abort();
        }
      })
      .catch((err) => console.error(`heartbeat error for ${videoId}`, err));
  }, config.heartbeatMs);

  try {
    // Step 3: the heavy work.
    await processor.process(video, controller.signal);
    const done = await store.completeProcessing(videoId, attempt, 'ready');
    return done ? 'ready' : 'lost';
  } catch (err) {
    if (leaseLost) return 'lost'; // not our video anymore: write nothing

    const message = err instanceof Error ? err.message : String(err);
    console.error(`processing ${videoId} attempt ${attempt} failed: ${message}`);

    if (err instanceof PermanentProcessingError) {
      return (await store.completeProcessing(videoId, attempt, 'failed', message)) ? 'failed' : 'lost';
    }
    if (attempt >= config.maxAttempts) {
      const reason = `Gave up after ${attempt} attempts: ${message}`;
      return (await store.completeProcessing(videoId, attempt, 'failed', reason)) ? 'failed' : 'lost';
    }

    // Temporary problem: back to the queue for another try.
    if (!(await store.completeProcessing(videoId, attempt, 'queued'))) return 'lost';
    await queue.enqueue(videoId, attempt + 1, config.retryDelayMs);
    return 'retry_scheduled';
  } finally {
    clearInterval(timer);
  }
}