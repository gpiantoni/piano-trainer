// What a folder rescan has to do. Pure: no DOM, no IndexedDB, tested in Node.

export type FoundFile = { path: string; lastModified: number; size: number };

export type StoredFile = {
  id: string;
  path: string;            // the path it had in its folder
  lastModified: number;
  size: number;
  missing?: boolean;
};

export type FolderDiff<F extends FoundFile> = {
  add: { file: F; adopt?: string }[];   // adopt: reuse this record id (and its history)
  changed: { file: F; id: string }[];   // date or size differ: read and hash it
  unchanged: { file: F; id: string }[];
  missing: string[];                    // ids now absent from the folder
};

// `stored`: records of this folder. `orphans`: folder records whose folder was
// unlinked. Relinking the same folder then updates them instead of duplicating.
// A renamed file shows up as missing + add, which is fine: nothing is lost.
export function diffFolder<F extends FoundFile>(stored: StoredFile[], found: F[], orphans: StoredFile[] = []): FolderDiff<F> {
  const byPath = new Map(stored.map((s) => [s.path, s]));
  const orphanByPath = new Map(orphans.map((s) => [s.path, s]));
  const seen = new Set<string>();
  const diff: FolderDiff<F> = { add: [], changed: [], unchanged: [], missing: [] };

  for (const file of found) {
    const s = byPath.get(file.path);
    if (!s) {
      diff.add.push({ file, adopt: orphanByPath.get(file.path)?.id });
      continue;
    }
    seen.add(s.id);
    const same = s.lastModified === file.lastModified && s.size === file.size;
    (same ? diff.unchanged : diff.changed).push({ file, id: s.id });
  }
  for (const s of stored) if (!seen.has(s.id) && !s.missing) diff.missing.push(s.id);
  return diff;
}

// "just now", "5 min ago", "3 h ago", "2 days ago".
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const min = Math.round((now - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
