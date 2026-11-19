import type { JobQueue } from '../queue/jobQueue.js';
import { transitionVideo, type TransitionResult, type VideoStore } from '../domain/transition.js';

/** Called after upload completes. Only the one request that wins the race enqueues. */
export async function enqueueUploadedVideo(
  store: VideoStore,
  queue: JobQueue,
  videoId: string,
): Promise<TransitionResult> {
  const result = await transitionVideo(store, videoId, 'uploaded', 'queued');
  if (result === 'applied') {
    await queue.enqueue(videoId, 1);
  }
  return result;
}