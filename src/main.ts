import './style.css';
import { fetchManifest, layoutScore, loadScore, type ScoreEntry } from './score/load.ts';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="bar">
    <select id="picker" aria-label="Score"></select>
    <div class="zoom" role="group" aria-label="Notation size">
      <button id="zoomOut" aria-label="Smaller">−</button>
      <output id="zoomLevel"></output>
      <button id="zoomIn" aria-label="Larger">+</button>
    </div>
    <a class="debug" href="${import.meta.env.BASE_URL}spike.html">MIDI debugger</a>
  </header>
  <p id="status" class="status"></p>
  <div id="score" class="score"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const picker = $<HTMLSelectElement>('picker');
const status = $('status');
const score = $('score');

// localStorage can throw (private mode, blocked storage); the app works without it.
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// Notation size is verovio's `scale`. Changing it re-flows the bars, so a larger
// size means fewer bars per line, never horizontal scrolling. Tune on the tablet.
const SCALE_MIN = 20, SCALE_MAX = 100, SCALE_STEP = 5;
let scale = Number(store.get('scale')) || 45;

let entries: ScoreEntry[] = [];
let loaded: ScoreEntry | undefined;
let seq = 0;                        // drops a slow render superseded by a newer one
let laidOutWidth = 0;

async function layout(mine?: number) {
  if (!loaded) return;
  mine ??= ++seq;
  const width = score.clientWidth;
  const pages = await layoutScore(width, scale);
  if (mine !== seq) return;
  score.innerHTML = pages.join('');
  laidOutWidth = width;
}

async function show(entry: ScoreEntry) {
  const mine = ++seq;
  status.textContent = `Loading ${entry.title}…`;
  try {
    await loadScore(entry);
    if (mine !== seq) return;
    loaded = entry;
    await layout(mine);
    // A resize may have re-flowed meanwhile; that still shows this score.
    if (loaded !== entry) return;
    window.scrollTo(0, 0);
    status.textContent = entry.composer ? `${entry.title} — ${entry.composer}` : entry.title;
    store.set('score', entry.id);
  } catch (err) {
    if (mine !== seq && loaded !== entry) return;
    loaded = undefined;
    score.innerHTML = '';
    status.textContent = `Could not render ${entry.title}: ${(err as Error).message}`;
  }
}

function setScale(next: number) {
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
  $('zoomLevel').textContent = `${scale}`;
  store.set('scale', String(scale));
  layout();
}
$('zoomOut').onclick = () => setScale(scale - SCALE_STEP);
$('zoomIn').onclick = () => setScale(scale + SCALE_STEP);
$('zoomLevel').textContent = `${scale}`;

// Re-flow when the width changes (window resize, tablet rotation); debounced
// because a drag-resize fires continuously.
let resizeTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (score.clientWidth !== laidOutWidth) layout();
  }, 150);
}).observe(score);

picker.onchange = () => {
  const entry = entries.find((e) => e.id === picker.value);
  if (entry) show(entry);
};

try {
  entries = await fetchManifest();
} catch (err) {
  status.textContent = `Could not load the score list: ${(err as Error).message}`;
}

if (entries.length === 0 && !status.textContent) {
  status.textContent = 'No scores found. Put .musicxml files in public/scores/.';
}
picker.replaceChildren(...entries.map((e) =>
  new Option(e.composer ? `${e.title} (${e.composer})` : e.title, e.id)));

const initial = entries.find((e) => e.id === store.get('score'))
  ?? entries.find((e) => e.title === 'Minuet in G')
  ?? entries[0];
if (initial) {
  picker.value = initial.id;
  show(initial);
}
