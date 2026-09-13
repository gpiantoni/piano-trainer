import type { VerovioToolkit } from 'verovio/esm';
import { buildTimeline, type ScoreTiming } from './timeline.ts';
import { meiMeta, musicXmlMeta, type ScoreMeta } from './meta.ts';

// A score as the file holds it: MusicXML text, or the bytes of a zipped .mxl.
export type ScoreData = { kind: 'xml'; text: string } | { kind: 'mxl'; bytes: ArrayBuffer };

// One entry in the score picker, wherever the file lives.
export type ScoreEntry = {
  id: string;        // bundled: path under scores/ without extension; device: uuid
  title: string;
  composer: string;
} & (
  | { source: 'bundled'; path: string }     // path relative to scores/
  | { source: 'device'; missing?: boolean; updatedAt: string } // data in IndexedDB (library/db.ts)
);

const scoresUrl = (p: string) => `${import.meta.env.BASE_URL}scores/${p}`;

export async function fetchManifest(): Promise<ScoreEntry[]> {
  const r = await fetch(scoresUrl('manifest.json'));
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
  const list: { id: string; title: string; composer: string; path: string }[] = await r.json();
  return list.map((e) => ({ ...e, source: 'bundled' }));
}

export async function fetchBundled(path: string): Promise<ScoreData> {
  const r = await fetch(scoresUrl(encodeURI(path)));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return { kind: 'xml', text: await r.text() };
}

let verovioModule: Promise<unknown> | undefined;
let toolkit: Promise<VerovioToolkit> | undefined;

// The verovio module embeds ~7 MB of WASM, so it is imported lazily and once.
// Several toolkits can share it: the score on screen, and the import checker.
async function newToolkit(): Promise<VerovioToolkit> {
  verovioModule ??= import('verovio/wasm').then(({ default: create }) => create());
  const [module, { VerovioToolkit }] = await Promise.all([verovioModule, import('verovio/esm')]);
  return new VerovioToolkit(module);
}

export function getToolkit(): Promise<VerovioToolkit> {
  toolkit ??= (async () => {
    const tk = await newToolkit();
    tk.setOptions({
      breaks: 'auto',          // wrap bars into systems, like a printed page
      adjustPageHeight: true,
      pageHeight: 60000,       // the maximum: one tall page, scrolled vertically
      svgViewBox: true,        // no fixed width/height: CSS sizes the SVG
      header: 'none',
      footer: 'none',
      pageMarginTop: 50,
      pageMarginBottom: 50,
      pageMarginLeft: 50,
      pageMarginRight: 50,
      spacingStaff: 8,
      spacingSystem: 14,
    });
    return tk;
  })();
  return toolkit;
}

// Anything that is not a zip makes verovio's unzip throw a WASM exception
// instead of returning false, so check the local-file-header signature first.
const isZip = (b: ArrayBuffer) => {
  const s = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  return s.length === 4 && s[0] === 0x50 && s[1] === 0x4b && s[2] === 0x03 && s[3] === 0x04;
};

function loadInto(tk: VerovioToolkit, data: ScoreData, name: string): ScoreTiming {
  if (data.kind === 'mxl' && !isZip(data.bytes)) throw new Error(`${name} is not a compressed MusicXML (.mxl) file`);
  const ok = data.kind === 'xml' ? tk.loadData(data.text) : tk.loadZipDataBuffer(data.bytes);
  if (!ok) throw new Error(`verovio could not read ${name}\n${tk.getLog()}`.trim());
  const timing = buildTimeline(tk);
  if (timing.events.length === 0) throw new Error(`${name} has no notes to play`);
  return timing;
}

export async function loadScore(data: ScoreData, name: string): Promise<ScoreTiming> {
  return loadInto(await getToolkit(), data, name);
}

// A second toolkit checks imported files, so an import never replaces the score
// on screen (its note ids and layout stay valid). After a WASM exception the
// toolkit's state is unknown, so it is dropped and rebuilt on the next file.
let checker: Promise<VerovioToolkit> | undefined;

export async function inspectScore(data: ScoreData, name: string): Promise<ScoreMeta & { notes: number }> {
  checker ??= newToolkit().then((tk) => { tk.setOptions({ breaks: 'none', header: 'none', footer: 'none' }); return tk; });
  const tk = await checker;
  try {
    const { events } = loadInto(tk, data, name);
    const meta = data.kind === 'xml' ? musicXmlMeta(data.text) : meiMeta(tk.getMEI());
    return { ...meta, notes: events.length };
  } catch (err) {
    if (!(err instanceof Error)) checker = undefined;
    throw err instanceof Error ? err : new Error(`verovio crashed reading ${name}`);
  }
}

// Lay the loaded score out for a container `widthPx` wide. The rendered viewBox
// is pageWidth * scale / 100 wide, so this pageWidth makes one SVG unit one CSS
// pixel: `scale` is then the notation size, independent of screen width.
export async function layoutScore(widthPx: number, scale: number): Promise<string[]> {
  const tk = await getToolkit();
  tk.setOptions({ scale, pageWidth: Math.round((widthPx * 100) / scale) });
  tk.redoLayout();
  const pages: string[] = [];
  for (let p = 1; p <= tk.getPageCount(); p++) pages.push(tk.renderToSVG(p));
  return pages;
}
