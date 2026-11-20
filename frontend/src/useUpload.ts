import { useCallback, useEffect, useReducer, useRef } from 'react';
import { completeUpload, createUpload, getParts, getPlayback, getVideo, type VideoView } from './api';
import { contentTypeOf } from './files';
import { uploadKeyFor } from './identity';
import { sleep } from './sleep';
import { initialState, reducer } from './uploadState';
import { uploadParts, type UploadPlan } from './uploader';
import { xhrPutPart } from './xhr';

async function waitOnline(signal: AbortSignal): Promise<void> {
  while (!navigator.onLine) await sleep(500, signal);
}

/** Polls until the video reaches a final status. A few failed polls in a row are tolerated. */
async function pollUntilDone(
  creatorId: string,
  videoId: string,
  signal: AbortSignal,
  onStatus: (status: string) => void,
): Promise<VideoView> {
  let last = '';
  let failures = 0;
  for (;;) {
    try {
      const { video } = await getVideo(creatorId, videoId);
      failures = 0;
      if (video.status !== last) {
        last = video.status;
        onStatus(video.status);
      }
      if (video.status === 'ready' || video.status === 'failed' || video.status === 'abandoned') {
        return video;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      if (++failures >= 5) throw err; // the network is really gone, not just slow
    }
    await sleep(2000, signal);
  }
}

export function useUpload(creatorId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const controllerRef = useRef<AbortController | null>(null);

  // Leaving the page stops any work in progress.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const start = useCallback(
    async (file: File) => {
      const contentType = contentTypeOf(file.name, file.type);
      if (!contentType) {
        dispatch({ type: 'failed', message: 'Unsupported file type. Use MP4, MOV, MKV or WebM.' });
        return;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;

      const log = (message: string, isError = false) =>
        dispatch({ type: 'log', message, isError, at: Date.now() });

      dispatch({ type: 'begin', totalBytes: file.size });

      try {
        const created = await createUpload(creatorId, uploadKeyFor(file), {
          filename: file.name,
          sizeBytes: file.size,
          contentType,
        });
        const videoId = created.video.id;
        dispatch({ type: 'created', videoId });
        log(`Video ${videoId} (${created.video.status})`);

        if (created.upload) {
          const stored = created.upload.uploadedParts.length;
          if (stored > 0) {
            log(`Resuming: storage already has ${stored} of ${created.upload.totalParts} parts`);
          }

          await uploadParts(
            file,
            created.upload,
            {
              putPart: async (url, body, onProgress, partSignal) => {
                await waitOnline(signal);
                return xhrPutPart(url, body, onProgress, partSignal);
              },
              refreshPlan: async (): Promise<UploadPlan> => (await getParts(creatorId, videoId)).upload,
              sleep: (ms) => sleep(ms, signal),
              isOffline: () => !navigator.onLine,
            },
            {
              signal,
              onProgress: (bytes) => dispatch({ type: 'progress', bytes }),
              onEvent: (message) => log(message),
            },
          );

          dispatch({ type: 'phase', phase: 'finishing', message: 'Finishing upload...' });
          await completeUpload(creatorId, videoId);
          log('Upload complete');
        } else {
          log('This file was already uploaded earlier; checking its status');
        }

        dispatch({ type: 'phase', phase: 'processing', message: 'Processing your video...' });
        const finished = await pollUntilDone(creatorId, videoId, signal, (status) =>
          log(`Status: ${status}`),
        );

        if (finished.status === 'ready') {
          dispatch({ type: 'ready', playback: await getPlayback(videoId) });
        } else {
          const reason = finished.failureReason ?? `The video was ${finished.status}`;
          log(`Failed: ${reason}`, true);
          dispatch({ type: 'failed', message: `This video could not be processed: ${reason}` });
        }
      } catch (err) {
        if (signal.aborted) {
          log('Cancelled');
          dispatch({ type: 'cancelled' });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log(message, true);
        dispatch({ type: 'failed', message: `Problem: ${message}` });
      }
    },
    [creatorId],
  );

  return { state, start, cancel, reset };
}