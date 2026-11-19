import { Worker } from 'bullmq';
import { QUEUE_NAME, redisConnection } from '../queue/jobQueue.js';
import { processVideo, type ProcessDeps } from './processVideo.js';

export interface StartWorkerOptions {
  deps: ProcessDeps;
  queueName?: string;
  connection?: ReturnType<typeof redisConnection>;
  concurrency?: number;
}

export function startWorker(options: StartWorkerOptions): Worker {
  const worker = new Worker(
    options.queueName ?? QUEUE_NAME,
    async (job) => {
      const { videoId } = job.data as { videoId: string };
      const outcome = await processVideo(options.deps, videoId);
      console.log(`video ${videoId}: ${outcome}`);
    },
    {
      connection: options.connection ?? redisConnection(),
      concurrency: options.concurrency ?? 2,
      // Recovering from a dead worker is the watchdog's job, using Postgres
      // as the single source of truth. The queue must not also re-deliver on its own.
      maxStalledCount: 0,
    },
  );
  worker.on('error', (err) => console.error('worker error', err));
  return worker;
}