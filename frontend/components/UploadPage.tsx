import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACCEPT, formatBytes, percent } from '../src/files';
import { getCreatorId } from '../src/identity';
import { isBusy } from '../src/uploadState';
import { useUpload } from '../src/useUpload';
import { ActivityLog } from './ActivityLog';
import { Player } from './Player';

export function UploadPage() {
  const [creatorId] = useState(() => getCreatorId());
  const { state, start, cancel, reset } = useUpload(creatorId);
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = isBusy(state.phase);
  const pct = percent(state.progressBytes, state.totalBytes);
  const statusText =
    state.phase === 'uploading'
      ? `Uploading ${pct}% (${formatBytes(state.progressBytes)} of ${formatBytes(state.totalBytes)})`
      : state.message;

  return (
    <>
      <section>
        <h2>1. Upload</h2>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (state.phase !== 'idle') reset();
          }}
        />
        <div className="row">
          <button disabled={!file || busy} onClick={() => file && void start(file)}>
            Upload
          </button>
          {busy && state.phase !== 'processing' && <button onClick={cancel}>Cancel</button>}
          <span role="status" aria-live="polite" className={state.phase === 'failed' ? 'error' : undefined}>
            {statusText}
          </span>
        </div>
        {state.totalBytes > 0 && <progress value={pct} max={100} />}
        <small className="muted">Creator ID (stand-in for login): {creatorId}</small>
      </section>

      {state.playback && (
        <section>
          <h2>2. Watch</h2>
          <Player manifestUrl={state.playback.manifestUrl} posterUrl={state.playback.posterUrl} />
          <p>
            Share link: <Link to={`/watch/${state.playback.id}`}>/watch/{state.playback.id}</Link>
          </p>
        </section>
      )}

      <section>
        <h2>Activity</h2>
        <ActivityLog entries={state.log} />
      </section>
    </>
  );
}