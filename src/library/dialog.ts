import { ago } from './scan.ts';
import {
  deleteFolder, deleteScore, listFolders, listScores, storageInfo,
  type FolderRecord, type ScoreRecord,
} from './db.ts';
import {
  canLinkFolders, describe, ensurePermission, importFiles, pickFolder, scanFolder, type ImportResult,
} from './import.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const e: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

// The Library dialog: add files, link a folder, rescan, unlink, remove.
// `changed` runs after anything that alters the list of device scores.
export class LibraryDialog {
  readonly dialog: HTMLDialogElement;
  private status: HTMLElement;
  private problems: HTMLElement;
  private folders: HTMLElement;
  private scores: HTMLElement;
  private storage: HTMLElement;
  private fileInput: HTMLInputElement;
  private busy = false;
  private changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    // No `accept`: Android does not know the .musicxml MIME type and would grey
    // those files out. Files are filtered by extension after picking instead.
    this.fileInput = el('input', { type: 'file', multiple: true, hidden: true });
    this.fileInput.onchange = () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      if (files.length) this.run((p) => importFiles(files, p));
    };

    const addFiles = el('button', { className: 'primary', textContent: 'Add files…' });
    addFiles.onclick = () => this.fileInput.click();

    const linkFolder = el('button', { textContent: 'Link folder…', hidden: !canLinkFolders() });
    linkFolder.onclick = () => this.run(async (p) => {
      const folder = await pickFolder();
      return folder ? scanFolder(folder, p) : undefined;
    });

    const close = el('button', { textContent: 'Close' });
    close.onclick = () => this.dialog.close();

    this.status = el('p', { className: 'lib-status' });
    this.status.setAttribute('aria-live', 'polite');
    this.problems = el('ul', { className: 'lib-problems' });
    this.folders = el('div');
    this.scores = el('div');
    this.storage = el('p', { className: 'lib-note' });

    this.dialog = el('dialog', { className: 'calib library' },
      el('h2', { textContent: 'Library' }),
      el('p', { className: 'lib-note', textContent: canLinkFolders()
        ? 'Scores are copied into this browser. A linked folder can be rescanned after you export again.'
        : 'Scores are copied into this browser. This browser cannot link folders: add files instead.' }),
      el('div', { className: 'calib-buttons' }, addFiles, linkFolder, this.fileInput),
      this.status, this.problems, this.folders, this.scores, this.storage,
      el('div', { className: 'calib-buttons' }, close),
    );
    document.body.append(this.dialog);
  }

  async open() {
    this.status.textContent = '';
    this.problems.replaceChildren();
    await this.render();
    this.dialog.showModal();
  }

  // One operation at a time; the buttons stay visible but do nothing meanwhile.
  private async run(op: (progress: (t: string) => void) => Promise<ImportResult | undefined>) {
    if (this.busy) return;
    this.busy = true;
    this.dialog.classList.add('busy');
    this.problems.replaceChildren();
    try {
      const result = await op((t) => { this.status.textContent = t; });
      if (result) {
        this.status.textContent = describe(result);
        this.problems.replaceChildren(...result.failed.map((f) => el('li', {}, el('b', { textContent: f.name }), ` — ${f.error}`)));
      } else {
        this.status.textContent = '';
      }
    } catch (err) {
      this.status.textContent = `Failed: ${(err as Error).message}`;
    } finally {
      this.busy = false;
      this.dialog.classList.remove('busy');
      await this.render();
      this.changed();
    }
  }

  private async render() {
    const [folders, scores, storage] = await Promise.all([listFolders(), listScores(), storageInfo()]);
    const linked = new Map(folders.map((f) => [f.id, f]));

    this.folders.replaceChildren(...(folders.length ? [
      el('h3', { textContent: 'Linked folders' }),
      el('ul', { className: 'lib-list' }, ...folders.map((f) => this.folderRow(f))),
    ] : []));

    const sorted = scores.sort((a, b) => a.title.localeCompare(b.title));
    this.scores.replaceChildren(
      el('h3', { textContent: `On this device (${scores.length})` }),
      scores.length
        ? el('ul', { className: 'lib-list' }, ...sorted.map((s) => this.scoreRow(s, linked)))
        : el('p', { className: 'lib-note', textContent: 'None yet.' }),
    );

    this.storage.textContent = storage
      ? `${storage.usedMb.toFixed(1)} MB used${storage.persisted ? ' · kept when storage is low' : ''}`
      : '';
  }

  private folderRow(f: FolderRecord) {
    const rescan = el('button', { textContent: 'Rescan' });
    // Permission first, while the tap still counts as a user gesture.
    rescan.onclick = () => this.run(async (p) => {
      if (!(await ensurePermission(f.handle))) throw new Error(`no permission to read ${f.name}`);
      return scanFolder(f, p);
    });
    const unlink = el('button', { textContent: 'Unlink', title: 'Stop rescanning this folder; its scores stay' });
    unlink.onclick = () => this.run(async () => { await deleteFolder(f.id); return undefined; });
    return el('li', {},
      el('span', { className: 'lib-name' }, `📁 ${f.name}`, el('small', { textContent: ` scanned ${ago(f.scannedAt)}` })),
      rescan, unlink);
  }

  private scoreRow(s: ScoreRecord, linked: Map<string, FolderRecord>) {
    const folder = s.source.kind === 'folder' ? linked.get(s.source.folderId) : undefined;
    const from = s.source.kind === 'file' ? s.source.name
      : `${folder?.name ?? 'unlinked folder'}/${s.source.path}`;
    const row = el('li', {},
      el('span', { className: 'lib-name' },
        s.composer ? `${s.title} — ${s.composer}` : s.title,
        el('small', { textContent: ` ${from}${s.missing ? ' · not in folder' : ''}` })));
    // A score that its linked folder still has would come back on the next
    // rescan, so it is managed by the folder: unlink it first to remove it.
    if (!folder || s.missing) {
      const remove = el('button', { textContent: 'Remove' });
      remove.onclick = () => {
        if (!confirm(`Remove “${s.title}” from this device?`)) return;
        this.run(async () => { await deleteScore(s.id); return undefined; });
      };
      row.append(remove);
    }
    return row;
  }
}
