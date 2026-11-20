import type { LogEntry } from '../src/uploadState';


export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <ol className="log">
      {entries.map((entry) => (
        <li key={entry.id} className={entry.isError ? 'error' : undefined}>
          {/* Rendered as text by React, so a hostile filename can never run as HTML */}
          {new Date(entry.at).toLocaleTimeString()} {entry.message}
        </li>
      ))}
    </ol>
  );
}