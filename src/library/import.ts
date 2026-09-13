import { inspectScore, type ScoreData } from '../score/load.ts';
import { baseName, scoreKind } from '../score/meta.ts';
import { diffFolder, type StoredFile } from './scan.ts';
import {
  listFolders, listScores, persistStorage, putFolder, putScore,
  type FolderRecord, type ScoreRecord,
} from './db.ts';

export type ImportResult = {
  added: string[];                          // titles
  updated: string[];
  unchanged: number;
  already: string[];                        // same content already in the library
  missing: number;
  failed: { name: string; error: string }[];
  skipped: string[];                        // not a score file (picked files only)
};

const emptyResult = (): ImportResult =>
  ({ added: [], updated: [], unchanged: 0, already: [], missing: 0, failed: [], skipped: [] });

export function describe(r: ImportResult): string {
  const parts = [
    r.added.length && `Added ${r.added.length}`,
    r.updated.length && `updated ${r.updated.length}`,
    r.unchanged && `${r.unchanged} unchanged`,
    r.already.length && `${r.already.length} already in the library`,
    r.missing && `${r.missing} no longer in the folder`,
    r.failed.length && `${r.failed.length} could not be read`,
    r.skipped.length && `skipped: ${r.skipped.join(', ')}`,
  ].filter(Boolean) as string[];
  const line = parts.join(' · ') || 'Nothing to import';
  return line[0].toUpperCase() + line.slice(1);
}

export type Progress = (text: string) => void;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// MusicXML is almost always UTF-8, but a few Windows apps write UTF-16 with a BOM.
function decodeText(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const enc = b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(enc).decode(bytes);
}

async function readFile(file: File, kind: 'xml' | 'mxl'): Promise<{ data: ScoreData; hash: string }> {
  const bytes = await file.arrayBuffer();
  const hash = await sha256(bytes);
  return { hash, data: kind === 'xml' ? { kind, text: decodeText(bytes) } : { kind, bytes } };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0];

// Check the file renders, then build the record to save. Throws if it does not.
async function toRecord(
  file: File, read: { data: ScoreData; hash: string }, source: ScoreRecord['source'], previous?: ScoreRecord,
): Promise<ScoreRecord> {
  const meta = await inspectScore(read.data, file.name);
  const now = new Date().toISOString();
  return {
    id: previous?.id ?? crypto.randomUUID(),
    title: meta.title || baseName(file.name),
    composer: meta.composer,
    data: read.data,
    hash: read.hash,
    source,
    addedAt: previous?.addedAt ?? now,
    updatedAt: now,
  };
}

// ---- picked files -----------------------------------------------------------

// A file with the same name as an earlier pick replaces it in place (a corrected
// export), keeping its id. Identical content anywhere in the library is skipped.
export async function importFiles(files: File[], progress: Progress = () => {}): Promise<ImportResult> {
  const result = emptyResult();
  const records = await listScores();

  for (const [i, file] of files.entries()) {
    const kind = scoreKind(file.name);
    if (!kind) { result.skipped.push(file.name); continue; }
    progress(`Reading ${file.name} (${i + 1} / ${files.length})…`);
    try {
      const read = await readFile(file, kind);
      const same = records.find((r) => r.hash === read.hash);
      if (same) { result.already.push(same.title); continue; }
      const previous = records.find((r) => r.source.kind === 'file' && r.source.name === file.name);
      const record = await toRecord(file, read, { kind: 'file', name: file.name }, previous);
      await putScore(record);
      if (previous) records.splice(records.indexOf(previous), 1, record);
      else records.push(record);
      (previous ? result.updated : result.added).push(record.title);
    } catch (err) {
      result.failed.push({ name: file.name, error: message(err) });
    }
  }
  if (result.added.length) await persistStorage();
  return result;
}

// ---- linked folders ---------------------------------------------------------

export const canLinkFolders = () => typeof window.showDirectoryPicker === 'function';

// Reading a stored handle again needs permission, usually once per session, and
// the request must come from a tap: call this first thing in a click handler.
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'read' as const };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// Opens the folder picker. Picking a folder that is already linked returns that one.
export async function pickFolder(): Promise<FolderRecord | undefined> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ id: 'scores', mode: 'read' });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return undefined;   // picker closed
    throw err;
  }
  for (const f of await listFolders()) {
    if (await f.handle.isSameEntry(handle)) return f;
  }
  const folder: FolderRecord = { id: crypto.randomUUID(), name: handle.name, handle };
  await putFolder(folder);
  return folder;
}

type Found = { path: string; lastModified: number; size: number; file: File };

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: Found[]): Promise<Found[]> {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;                 // .git, .stfolder, .trash…
    const path = prefix + name;
    if (handle.kind === 'directory') {
      await walk(handle as FileSystemDirectoryHandle, `${path}/`, out);
    } else if (scoreKind(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path, lastModified: file.lastModified, size: file.size, file });
    }
  }
  return out;
}

const asStored = (r: ScoreRecord): StoredFile | undefined =>
  r.source.kind === 'folder'
    ? { id: r.id, path: r.source.path, lastModified: r.source.lastModified, size: r.source.size, missing: r.missing }
    : undefined;

// Bring the library in line with the folder: read only new or changed files,
// mark vanished ones as missing (their history stays), never delete anything.
export async function scanFolder(folder: FolderRecord, progress: Progress = () => {}): Promise<ImportResult> {
  const result = emptyResult();
  progress(`Listing ${folder.name}…`);
  const found = await walk(folder.handle, '', []);
  const [records, folders] = await Promise.all([listScores(), listFolders()]);
  const byId = new Map(records.map((r) => [r.id, r]));
  const linked = new Set(folders.map((f) => f.id));

  const ofFolder = (r: ScoreRecord) => r.source.kind === 'folder' && r.source.folderId === folder.id;
  const orphan = (r: ScoreRecord) => r.source.kind === 'folder' && !linked.has(r.source.folderId);
  const stored = records.filter(ofFolder).map(asStored) as StoredFile[];
  const orphans = records.filter(orphan).map(asStored) as StoredFile[];
  const diff = diffFolder(stored, found, orphans);

  const source = (f: Found): ScoreRecord['source'] =>
    ({ kind: 'folder', folderId: folder.id, path: f.path, lastModified: f.lastModified, size: f.size });

  const work = [
    ...diff.add.map(({ file, adopt }) => ({ file, id: adopt })),
    ...diff.changed,
  ];
  for (const [i, { file, id }] of work.entries()) {
    progress(`Reading ${file.path} (${i + 1} / ${work.length})…`);
    try {
      const read = await readFile(file.file, scoreKind(file.path)!);
      // A file picked on its own earlier, now found in the folder: take it over.
      const previous = (id ? byId.get(id) : undefined)
        ?? records.find((r) => r.source.kind === 'file' && r.hash === read.hash);
      if (previous?.hash === read.hash) {
        // Same notes (touched, copied, or adopted): just follow the file.
        await putScore({ ...previous, source: source(file), missing: false });
        result.unchanged++;
        continue;
      }
      const record = await toRecord(file.file, read, source(file), previous);
      await putScore(record);
      (previous ? result.updated : result.added).push(record.title);
    } catch (err) {
      result.failed.push({ name: file.path, error: message(err) });
    }
  }

  for (const { file, id } of diff.unchanged) {
    const r = byId.get(id)!;
    if (r.missing) await putScore({ ...r, source: source(file), missing: false });
    result.unchanged++;
  }
  for (const id of diff.missing) {
    await putScore({ ...byId.get(id)!, missing: true });
    result.missing++;
  }

  await putFolder({ ...folder, scannedAt: new Date().toISOString() });
  if (result.added.length) await persistStorage();
  return result;
}
