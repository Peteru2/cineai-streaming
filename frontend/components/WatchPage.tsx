import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getPlayback } from '../src/api';
import type { Playback } from '../src/uploadState';
import { Player } from './Player';

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; playback: Playback }
  | { kind: 'error'; message: string };

export function WatchPage() {
  const { id } = useParams();
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setView({ kind: 'loading' });

    getPlayback(id)
      .then((playback) => !cancelled && setView({ kind: 'ready', playback }))
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError && err.status === 404
            ? 'This video does not exist.'
            : err instanceof ApiError && err.code === 'not_ready'
              ? 'This video is not ready yet. Please check back soon.'
              : err instanceof Error
                ? err.message
                : 'Something went wrong.';
        setView({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section>
      {view.kind === 'loading' && <p className="muted">Loading...</p>}
      {view.kind === 'error' && <p className="error">{view.message}</p>}
      {view.kind === 'ready' && (
        <>
          <h2>{view.playback.filename}</h2>
          <Player manifestUrl={view.playback.manifestUrl} posterUrl={view.playback.posterUrl} />
        </>
      )}
    </section>
  );
}