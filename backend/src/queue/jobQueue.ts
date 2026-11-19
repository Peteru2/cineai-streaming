import { Queue } from 'bullmq';

export const QUEUE_NAME = 'video-processing';

export interface JobQueue {
  enqueue(videoId: string, attempt: number, delayMs?: number): Promise<void>;
}

export function redisConnection(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: env.REDIS_HOST ?? 'localhost',
    port: Number(env.REDIS_PORT ?? 6379),
  };
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(connection = redisConnection(), queueName = QUEUE_NAME) {
    this.queue = new Queue(queueName, { connection });
  }

  async enqueue(videoId: string, attempt: number, delayMs = 0): Promise<void> {
    await this.queue.add(
      'process',
      { videoId },
      {
        // One ticket per (video, attempt). Adding the same one twice is ignored.
        jobId: `${videoId}_a${attempt}`,
        delay: delayMs,
        attempts: 1, // retries are decided by us, in Postgres, not by the queue
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}