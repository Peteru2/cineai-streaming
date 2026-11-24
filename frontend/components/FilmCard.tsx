import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Film } from '../src/api';
import { formatDate, titleFromFilename } from '../src/files';

export function FilmCard({ film }: { film: Film }) {
  const [posterFailed, setPosterFailed] = useState(false);

  return (
    <Link to={`/watch/${film.id}`} className="card">
      <div className="card-media">
        {posterFailed ? (
          <div className="card-fallback" aria-hidden="true" />
        ) : (
          <img src={film.posterUrl} alt="" loading="lazy" onError={() => setPosterFailed(true)} />
        )}
        <span className="card-play" aria-hidden="true">
          ▶
        </span>
      </div>
      <div className="card-title">{titleFromFilename(film.filename)}</div>
      <div className="card-meta">{formatDate(film.createdAt)}</div>
    </Link>
  );
}