import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes, percent } from '../src/files';
import { getCreatorId } from '../src/identity';
import { stepStates } from '../src/steps';
import { initialState, isBusy } from '../src/uploadState';
import { useUpload } from '../src/useUpload';
import { ActivityLog } from './ActivityLog';
import { DropZone } from './DropZone';
import { Player } from './Player';
import { Stepper } from './Stepper';

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the field is selectable as a fallback
    }
  };

  return (
    <div className="row">
      <input
        className="link-input"
        readOnly
        value={url}
        aria-label="Share link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button className="btn" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}

export function UploadPage() {
  const [creatorId] = useState(() => getCreatorId());
  const { state, start, cancel, reset } = useUpload(creatorId);
  const [file, setFile] = useState<File | null>(null);

  const busy = isBusy(state.phase);
  const uploading = state.phase === 'starting' || state.phase === 'uploading' || state.phase === 'finishing';
  const pct = percent(state.progressBytes, state.totalBytes);
  const showStatus = state.phase !== 'idle' || state.message !== initialState.message;
  const statusText =
    state.phase === 'uploading'
      ? `Uploading ${pct}% (${formatBytes(state.progressBytes)} of ${formatBytes(state.totalBytes)})`
      : state.message;

  const choose = (selected: File) => {
    setFile(selected);
    if (state.phase !== 'idle') reset();
  };

  return (
    <div className="stack">
      <section className="panel">
        <h1 className="page-title">Upload your film</h1>
        <p className="lead">
          Large files are sent in small pieces. If your connection drops, you pick up where you stopped.
        </p>

        <DropZone disabled={busy} onSelect={choose} />

        {file && (
          <div className="file-chip">
            <div>
              <strong className="file-name">{file.name}</strong>
              <span className="muted"> · {formatBytes(file.size)}</span>
            </div>
            {!busy && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setFile(null);
                  reset();
                }}
              >
                Remove
              </button>
            )}
          </div>
        )}

        <div className="actions">
          <button className="btn btn-primary" disabled={!file || busy} onClick={() => file && void start(file)}>
            Upload film
          </button>
          {uploading && (
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>

        {state.phase !== 'idle' && <Stepper steps={stepStates(state.phase, state.serverStatus)} />}

        {state.resumed && (
          <p className="notice">
            Resuming: {state.resumed.stored} of {state.resumed.total} parts were already safe in storage, so
            only the rest is being sent.
          </p>
        )}

        {uploading && state.totalBytes > 0 && (
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Upload progress"
          >
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}

        {showStatus && (
          <p role="status" aria-live="polite" className={state.phase === 'failed' ? 'error' : 'status'}>
            {statusText}
          </p>
        )}

        {state.phase === 'uploading' && (
          <p className="muted small">
            You can close this tab. Select the same file again later and the upload continues.
          </p>
        )}
      </section>

      {state.playback && (
        <section className="panel">
          <h2 className="section-title">Your film is live</h2>
          <Player manifestUrl={state.playback.manifestUrl} posterUrl={state.playback.posterUrl} />
          <CopyLink url={`${window.location.origin}/watch/${state.playback.id}`} />
          <p>
            <Link to="/">See it on the home page</Link>
          </p>
        </section>
      )}

      <details className="panel">
        <summary>Activity log</summary>
        <ActivityLog entries={state.log} />
      </details>
    </div>
  );
}