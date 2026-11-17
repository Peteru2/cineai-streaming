import { assertTransition, type VideoStatus } from './status.js';

// Anything that can store video statuses must offer this one operation.
export interface VideoStore {
  /**
   * Atomically set the status to `to`, but ONLY if it is currently `from`.
   * Returns true if the change happened, false if the status was not `from`.
   */
  compareAndSetStatus(id: string, from: VideoStatus, to: VideoStatus): Promise<boolean>;
}

export type TransitionResult = 'applied' | 'lost_race';

export async function transitionVideo(
  store: VideoStore,
  id: string,
  from: VideoStatus,
  to: VideoStatus,
): Promise<TransitionResult> {
  assertTransition(from, to); // illegal moves throw before touching storage
  const changed = await store.compareAndSetStatus(id, from, to);
  return changed ? 'applied' : 'lost_race';
}