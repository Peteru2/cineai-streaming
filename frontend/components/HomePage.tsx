import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listFilms, type Film } from '../src/api';
import { FilmCard } from './FilmCard';

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; films: Film[] }
  | { kind: 'error'; message: string };

export function HomePage() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setView({ kind: 'loading' });

    listFilms()
      .then(({ films }) => !cancelled && setView({ kind: 'ready', films }))
      .catch((err: unknown) => {
        if (cancelled) return;
        setView({
          kind: 'error',
          message: err instanceof Error ? err.message : 'We could not load the films.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Generative cinema</p>
        <h1>Films made with AI, streamed to everyone.</h1>
        <p className="lead">
          Premieres from London to Lagos. Every film plays smoothly, whether you are on fibre or a phone with
          weak data.
        </p>
        <Link to="/upload" className="btn btn-primary">
          Upload your film
        </Link>
      </section>

      <section aria-labelledby="films-heading">
        <h2 id="films-heading" className="section-title">
          Now streaming
        </h2>

        {view.kind === 'loading' && (
          <div className="grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="card skeleton" aria-hidden="true">
                <div className="card-media" />
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
              </div>
            ))}
          </div>
        )}

        {view.kind === 'error' && (
          <div className="empty">
            <p className="error">{view.message}</p>
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}

        {view.kind === 'ready' && view.films.length === 0 && (
          <div className="empty">
            <p>No films yet. Be the first to premiere one.</p>
            <Link to="/upload" className="btn btn-primary">
              Upload your film
            </Link>
          </div>
        )}

        {view.kind === 'ready' && view.films.length > 0 && (
          <div className="grid">
            {view.films.map((film) => (
              <FilmCard key={film.id} film={film} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}