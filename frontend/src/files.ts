export const ACCEPT =
  'video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm';

const ALLOWED = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'];

const BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

/** The content type the API accepts for this file, or null if it is not a supported video. */
export function contentTypeOf(name: string, mime: string): string | null {
  if (ALLOWED.includes(mime)) return mime;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return BY_EXTENSION[extension] ?? null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** A readable title from a file name: "my_pilot_v2.mp4" becomes "my pilot v2". */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  const spaced = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || 'Untitled';
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}