import type { VerovioToolkit } from 'verovio/esm';
import type { ExpectedEvent } from '../types.ts';
import { buildTimeline } from './timeline.ts';

export type ScoreEntry = {
  id: string;        // path under scores/ without extension
  title: string;
  composer: string;
  path: string;      // relative to scores/
};

const scoresUrl = (p: string) => `${import.meta.env.BASE_URL}scores/${p}`;

export async function fetchManifest(): Promise<ScoreEntry[]> {
  const r = await fetch(scoresUrl('manifest.json'));
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
  return r.json();
}

let toolkit: Promise<VerovioToolkit> | undefined;

// The verovio module embeds ~7 MB of WASM, so it is imported lazily and once.
export function getToolkit(): Promise<VerovioToolkit> {
  toolkit ??= (async () => {
    const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
      import('verovio/wasm'),
      import('verovio/esm'),
    ]);
    const tk = new VerovioToolkit(await createVerovioModule());
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

export async function loadScore(entry: ScoreEntry): Promise<ExpectedEvent[]> {
  const [tk, xml] = await Promise.all([
    getToolkit(),
    fetch(scoresUrl(encodeURI(entry.path))).then((r) => {
      if (!r.ok) throw new Error(`${entry.path}: HTTP ${r.status}`);
      return r.text();
    }),
  ]);
  if (!tk.loadData(xml)) throw new Error(`verovio could not load ${entry.path}\n${tk.getLog()}`);
  return buildTimeline(tk);
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
