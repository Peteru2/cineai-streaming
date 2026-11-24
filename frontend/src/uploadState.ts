export type Phase =
  | 'idle'
  | 'starting'
  | 'uploading'
  | 'finishing'
  | 'processing'
  | 'ready'
  | 'failed';

export interface LogEntry {
  id: number;
  at: number;
  message: string;
  isError: boolean;
}

export interface Playback {
  id: string;
  filename: string;
  manifestUrl: string;
  posterUrl: string;
}

export interface UploadState {
  phase: Phase;
  message: string;
  progressBytes: number;
  totalBytes: number;
  videoId: string | null;
  playback: Playback | null;
  /** The last in-progress status the server reported (never "failed" or "abandoned"). */
  serverStatus: string | null;
  /** Set when an upload picked up where an earlier attempt stopped. */
  resumed: { stored: number; total: number } | null;
  log: LogEntry[];
  nextLogId: number;
}

export const initialState: UploadState = {
  phase: 'idle',
  message: 'Choose a video to upload.',
  progressBytes: 0,
  totalBytes: 0,
  videoId: null,
  playback: null,
  serverStatus: null,
  resumed: null,
  log: [],
  nextLogId: 1,
};

export type Action =
  | { type: 'begin'; totalBytes: number }
  | { type: 'created'; videoId: string }
  | { type: 'progress'; bytes: number }
  | { type: 'phase'; phase: Phase; message: string }
  | { type: 'serverStatus'; status: string }
  | { type: 'resumed'; stored: number; total: number }
  | { type: 'ready'; playback: Playback }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' }
  | { type: 'log'; message: string; isError?: boolean; at: number }
  | { type: 'reset' };

export const isBusy = (phase: Phase) =>
  phase === 'starting' || phase === 'uploading' || phase === 'finishing' || phase === 'processing';

export function reducer(state: UploadState, action: Action): UploadState {
  switch (action.type) {
    case 'begin':
      return {
        ...state,
        phase: 'starting',
        message: 'Starting upload...',
        progressBytes: 0,
        totalBytes: action.totalBytes,
        videoId: null,
        playback: null,
        serverStatus: null,
        resumed: null,
      };
    case 'created':
      return { ...state, videoId: action.videoId };
    case 'progress':
      // Late progress events must not drag a finished upload back to "uploading".
      if (state.phase !== 'starting' && state.phase !== 'uploading') return state;
      return { ...state, phase: 'uploading', progressBytes: action.bytes };
    case 'phase':
      return { ...state, phase: action.phase, message: action.message };
    case 'serverStatus':
      // Keep the last in-progress status, so a failure can say where it happened.
      if (action.status === 'failed' || action.status === 'abandoned') return state;
      return { ...state, serverStatus: action.status };
    case 'resumed':
      return { ...state, resumed: { stored: action.stored, total: action.total } };
    case 'ready':
      return { ...state, phase: 'ready', message: 'Ready to watch.', playback: action.playback };
    case 'failed':
      return { ...state, phase: 'failed', message: action.message };
    case 'cancelled':
      return {
        ...state,
        phase: 'idle',
        message: 'Upload cancelled. Select the same file again to resume.',
      };
    case 'log':
      return {
        ...state,
        log: [
          { id: state.nextLogId, at: action.at, message: action.message, isError: action.isError ?? false },
          ...state.log,
        ].slice(0, 200), // keep the log from growing forever
        nextLogId: state.nextLogId + 1,
      };
    case 'reset':
      return initialState;
  }
}