import './style.css';
import { fetchManifest, layoutScore, loadScore, type ScoreEntry } from './score/load.ts';
import { listenMidi } from './midi/input.ts';
import { WaitMode, noteName, type Feedback } from './engine/waitMode.ts';
import type { ExpectedEvent, Hands, NoteEvent } from './types.ts';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="bar">
    <select id="picker" aria-label="Score"></select>
    <div class="zoom" role="group" aria-label="Notation size">
      <button id="zoomOut" aria-label="Smaller">−</button>
      <output id="zoomLevel"></output>
      <button id="zoomIn" aria-label="Larger">+</button>
    </div>
    <div class="hands" role="radiogroup" aria-label="Hands">
      <button data-hands="both" role="radio">Both</button>
      <button data-hands="right" role="radio">Right</button>
      <button data-hands="left" role="radio">Left</button>
    </div>
    <button id="restart">Restart</button>
    <button id="fullscreen" hidden>Full screen</button>
    <span id="progress" class="progress"></span>
    <span id="feedback" class="feedback" aria-live="polite"></span>
    <span class="end">
      <span id="midi" class="midi"></span>
      <a class="debug" href="${import.meta.env.BASE_URL}spike.html">MIDI debugger</a>
    </span>
  </header>
  <p id="status" class="status"></p>
  <div id="score" class="score"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const picker = $<HTMLSelectElement>('picker');
const status = $('status');
const score = $('score');
const feedback = $('feedback');

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
let practice: WaitMode | undefined;
let timeline: ExpectedEvent[] = [];
let hands: Hands = (['both', 'right', 'left'] as const).find((h) => h === store.get('hands')) ?? 'both';

// ---- painting -------------------------------------------------------------

let noteEls = new Map<string, Element>();
let followedSystem: Element | null = null;

function paint() {
  const states = practice?.noteStates() ?? new Map();
  for (const [id, el] of noteEls) {
    const s = states.get(id);
    el.classList.toggle('hit', s === 'hit');
    el.classList.toggle('muted', s === 'muted');
  }
  $('progress').textContent = !practice ? ''
    : practice.done ? `Done · ${practice.wrong} wrong`
    : `${practice.cursor + 1} / ${practice.chords.length} · ${practice.wrong} wrong`;
}

// Keep the line being played in view, just below the sticky bar. Scrolls only
// when the current chord moves to another system, so the page does not twitch.
function follow(force = false) {
  const ev = practice?.current?.events[0];
  const system = ev ? noteEls.get(ev.id)?.closest('g.system') ?? null : null;
  if (!system || (system === followedSystem && !force)) return;
  followedSystem = system;
  const barBottom = document.querySelector('.bar')!.getBoundingClientRect().bottom;
  const top = system.getBoundingClientRect().top;
  window.scrollBy({ top: top - barBottom - 12, behavior: 'smooth' });
}

function clearFeedback() {
  feedback.textContent = '';
  feedback.className = 'feedback';
}

let flashTimer: number | undefined;
function flashWrong(f: Extract<Feedback, { kind: 'wrong' }>) {
  const want = f.expected.map(noteName).join(' ');
  feedback.textContent = `${noteName(f.pitch)} — expected ${want}`;
  feedback.className = 'feedback wrong';
  const ids = new Set(practice?.current?.events
    .filter((e) => f.expected.includes(e.pitch)).flatMap((e) => [e.id, ...e.tiedIds]));
  for (const id of ids) noteEls.get(id)?.classList.add('wrong');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    for (const el of score.querySelectorAll('g.note.wrong')) el.classList.remove('wrong');
    if (feedback.classList.contains('wrong')) clearFeedback();   // unless replaced since
  }, 600);
}

function onNote(ev: NoteEvent) {
  if (!practice) return;
  const out = practice.handle(ev);
  if (out.length === 0) return;
  for (const f of out) {
    if (f.kind === 'wrong') flashWrong(f);
    else if (f.kind === 'done') { feedback.textContent = 'Well played!'; feedback.className = 'feedback good'; }
  }
  paint();
  follow();
}

function restart() {
  if (!practice) return;
  practice.restart();
  clearFeedback();
  paint();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  followedSystem = null;
}
$('restart').onclick = restart;

// One hand only: the other staff greys out and is not asked for. Starts over.
const handButtons = [...document.querySelectorAll<HTMLButtonElement>('.hands button')];
function setHands(next: Hands) {
  hands = next;
  store.set('hands', hands);
  for (const b of handButtons) b.setAttribute('aria-checked', String(b.dataset.hands === hands));
  if (!loaded) return;
  practice = new WaitMode(timeline, hands);
  restart();
}
for (const b of handButtons) b.onclick = () => setHands(b.dataset.hands as Hands);
setHands(hands);

// Full screen hides the browser's address bar on the tablet. Not every browser
// can do it for a page (iPhone Safari), so the button only appears where it works.
const fullscreen = $<HTMLButtonElement>('fullscreen');
if (document.fullscreenEnabled) {
  fullscreen.hidden = false;
  fullscreen.onclick = () => document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen();
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });
}

// ---- layout ---------------------------------------------------------------

async function layout(mine?: number) {
  if (!loaded) return;
  mine ??= ++seq;
  const width = score.clientWidth;
  const pages = await layoutScore(width, scale);
  if (mine !== seq) return;
  score.innerHTML = pages.join('');
  laidOutWidth = width;
  noteEls = new Map([...score.querySelectorAll('g.note')].map((el) => [el.id, el]));
  followedSystem = null;
  paint();
}

async function show(entry: ScoreEntry) {
  const mine = ++seq;
  status.textContent = `Loading ${entry.title}…`;
  try {
    const events = await loadScore(entry);
    if (mine !== seq) return;
    loaded = entry;
    timeline = events;
    practice = new WaitMode(timeline, hands);
    clearFeedback();
    await layout(mine);
    // A resize may have re-flowed meanwhile; that still shows this score.
    if (loaded !== entry) return;
    window.scrollTo(0, 0);
    status.textContent = entry.composer ? `${entry.title} — ${entry.composer}` : entry.title;
    store.set('score', entry.id);
  } catch (err) {
    if (mine !== seq && loaded !== entry) return;
    loaded = undefined;
    practice = undefined;
    score.innerHTML = '';
    paint();
    status.textContent = `Could not render ${entry.title}: ${(err as Error).message}`;
  }
}

function setScale(next: number) {
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
  $('zoomLevel').textContent = `${scale}`;
  store.set('scale', String(scale));
  layout().then(() => follow(true));
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
    if (score.clientWidth !== laidOutWidth) layout().then(() => follow(true));
  }, 150);
}).observe(score);

picker.onchange = () => {
  const entry = entries.find((e) => e.id === picker.value);
  if (entry) show(entry);
};

// ---- MIDI -----------------------------------------------------------------

listenMidi(onNote, (s) => {
  const midi = $('midi');
  midi.className = `midi ${s.kind === 'ready' && s.inputs.length ? 'ok' : 'bad'}`;
  midi.textContent =
    s.kind === 'unsupported' ? 'No Web MIDI — use Chrome'
    : s.kind === 'denied' ? 'MIDI blocked'
    : s.inputs.length ? `🎹 ${s.inputs.join(', ')}`
    : 'No piano connected';
  midi.title = s.kind === 'denied' ? s.message : '';
});

// Dev only: play without a piano from the console, e.g. `__play(67)`.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __play: (pitch: number) => onNote({ type: 'on', pitch, velocity: 64, t: performance.now() }),
    __practice: () => practice,
  });
}

// ---- start ----------------------------------------------------------------

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
