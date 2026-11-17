export const VIDEO_STATUSES = [
  'uploading',
  'uploaded',
  'queued',
  'processing',
  'ready',
  'failed',
  'abandoned',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

// The rulebook: from each status, which statuses may come next.
export const ALLOWED_TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  uploading: ['uploaded', 'abandoned'],
  uploaded: ['queued', 'failed'],
  queued: ['processing'],
  processing: ['ready', 'failed', 'queued'], // 'queued' = retry after a stall
  ready: [],
  failed: [],
  abandoned: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: VideoStatus,
    public readonly to: VideoStatus,
  ) {
    super(`Invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: VideoStatus, to: VideoStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

// A terminal status has no exits: the video's story is over.
export function isTerminal(status: VideoStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}