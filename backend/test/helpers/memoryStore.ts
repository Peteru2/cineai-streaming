import type { VideoStore } from '../../src/domain/transition.js';
import type { VideoStatus } from '../../src/domain/status.js';

export class MemoryVideoStore implements VideoStore {
  private statuses = new Map<string, VideoStatus>();

  constructor(initial: Record<string, VideoStatus> = {}) {
    for (const [id, status] of Object.entries(initial)) {
      this.statuses.set(id, status);
    }
  }

  async compareAndSetStatus(id: string, from: VideoStatus, to: VideoStatus): Promise<boolean> {
    if (this.statuses.get(id) !== from) return false;
    this.statuses.set(id, to);
    return true;
  }

  get(id: string): VideoStatus | undefined {
    return this.statuses.get(id);
  }
}