import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getPlayback } from '../src/api';
import { titleFromFilename } from '../src/files';
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
            ? 'This film does not exist.'
            : err instanceof ApiError && err.code === 'not_ready'
              ? 'This film is still being prepared. Please check back soon.'
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
    <div className="watch">
      <Link to="/" className="back">
        ← All films
      </Link>
      {view.kind === 'loading' && <p className="muted">Loading...</p>}
      {view.kind === 'error' && <p className="error">{view.message}</p>}
      {view.kind === 'ready' && (
        <>
          <h1 className="page-title">{titleFromFilename(view.playback.filename)}</h1>
          <Player manifestUrl={view.playback.manifestUrl} posterUrl={view.playback.posterUrl} />
        </>
      )}
    </div>
  );
}