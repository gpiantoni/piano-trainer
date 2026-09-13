import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ScoreData } from '../score/load.ts';

// Scores imported from the device. The file's content is copied in: playing
// never needs file permission, and nothing breaks if the folder goes away.
export type ScoreRecord = {
  id: string;              // crypto.randomUUID() at first import, never changes
  title: string;
  composer: string;
  data: ScoreData;
  hash: string;            // SHA-256 of the file, to spot real changes
  source:
    | { kind: 'file'; name: string }
    | { kind: 'folder'; folderId: string; path: string; lastModified: number; size: number };
  missing?: boolean;       // the linked folder no longer has it; never auto-deleted
  addedAt: string;
  updatedAt: string;
};

export type FolderRecord = {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  scannedAt?: string;
};

interface LibrarySchema extends DBSchema {
  scores: { key: string; value: ScoreRecord };
  folders: { key: string; value: FolderRecord };
}

let db: Promise<IDBPDatabase<LibrarySchema>> | undefined;

function open() {
  db ??= openDB<LibrarySchema>('piano-trainer', 1, {
    upgrade(d) {
      d.createObjectStore('scores', { keyPath: 'id' });
      d.createObjectStore('folders', { keyPath: 'id' });
    },
  });
  return db;
}

export const listScores = async () => (await open()).getAll('scores');
export const getScore = async (id: string) => (await open()).get('scores', id);
export const putScore = async (s: ScoreRecord) => { await (await open()).put('scores', s); };
export const deleteScore = async (id: string) => { await (await open()).delete('scores', id); };

export const listFolders = async () => (await open()).getAll('folders');
export const putFolder = async (f: FolderRecord) => { await (await open()).put('folders', f); };
export const deleteFolder = async (id: string) => { await (await open()).delete('folders', id); };

// Ask the browser not to evict the library when the device runs low on space.
// Chrome decides silently (installed app, engagement); it never prompts.
export async function persistStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

export async function storageInfo(): Promise<{ usedMb: number; persisted: boolean } | undefined> {
  try {
    const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]);
    return { usedMb: (est.usage ?? 0) / 1e6, persisted };
  } catch {
    return undefined;
  }
}
