type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // private mode, or storage blocked
  }
}

/** Returns the saved value, or creates and saves one. Never throws if storage is unavailable. */
export function remembered(
  key: string,
  make: () => string,
  storage: KeyValueStorage | null = browserStorage(),
): string {
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
  } catch {
    // fall through and make a new one
  }
  const value = make();
  try {
    storage?.setItem(key, value);
  } catch {
    // the value just will not survive a reload
  }
  return value;
}

// Stand-in for real login: one random identity per browser.
export const getCreatorId = (storage?: KeyValueStorage | null) =>
  remembered('cineai.creator', () => crypto.randomUUID(), storage);

/** The same file (name, size, date) always gets the same key, so re-selecting it resumes. */
export const uploadKeyFor = (
  file: { name: string; size: number; lastModified: number },
  storage?: KeyValueStorage | null,
) =>
  remembered(`cineai.key.${file.name}:${file.size}:${file.lastModified}`, () => crypto.randomUUID(), storage);