import type { JobQueue } from '../../src/queue/jobQueue.js';

export class FakeQueue implements JobQueue {
  jobs: { videoId: string; attempt: number; delayMs: number }[] = [];

  async enqueue(videoId: string, attempt: number, delayMs = 0): Promise<void> {
    this.jobs.push({ videoId, attempt, delayMs });
  }
}