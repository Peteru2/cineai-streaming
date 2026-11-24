import type { Phase } from './uploadState';

export const STEP_LABELS = ['Upload', 'Queued', 'Processing', 'Ready'] as const;
export type StepState = 'todo' | 'active' | 'done' | 'failed';

/** Which of the four steps is done, current, failed or still to come. */
export function stepStates(phase: Phase, serverStatus: string | null): StepState[] {
  switch (phase) {
    case 'idle':
      return ['todo', 'todo', 'todo', 'todo'];
    case 'starting':
    case 'uploading':
    case 'finishing':
      return ['active', 'todo', 'todo', 'todo'];
    case 'processing':
      return serverStatus === 'processing'
        ? ['done', 'done', 'active', 'todo']
        : ['done', 'active', 'todo', 'todo'];
    case 'ready':
      return ['done', 'done', 'done', 'done'];
    case 'failed':
      if (serverStatus === 'ready') return ['done', 'done', 'done', 'failed'];
      if (serverStatus === 'processing') return ['done', 'done', 'failed', 'todo'];
      if (serverStatus === 'queued' || serverStatus === 'uploaded') return ['done', 'failed', 'todo', 'todo'];
      return ['failed', 'todo', 'todo', 'todo'];
  }
}