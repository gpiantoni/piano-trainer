import './style.css';
import { fetchManifest, layoutScore, loadScore, type ScoreEntry } from './score/load.ts';
import type { ScoreTiming } from './score/timeline.ts';
import { CursorMap } from './score/cursor.ts';
import { listenMidi } from './midi/input.ts';
import { WaitMode, forHands, noteName, type Feedback } from './engine/waitMode.ts';
import { Metronome } from './engine/metronome.ts';
import { TempoRun } from './engine/tempoRun.ts';
import { align } from './engine/align.ts';
import { CALIBRATION, estimateLatency } from './engine/calibration.ts';
import { ReviewView } from './review/view.ts';
import type { Hands, NoteEvent } from './types.ts';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="bar">
    <select id="picker" aria-label="Score"></select>
    <div class="zoom" role="group" aria-label="Notation size">
      <button id="zoomOut" aria-label="Smaller">−</button>
      <output id="zoomLevel"></output>
      <button id="zoomIn" aria-label="Larger">+</button>
    </div>
    <div class="seg" id="modes" role="radiogroup" aria-label="Mode">
      <button data-mode="wait" role="radio">Wait</button>
      <button data-mode="tempo" role="radio">Tempo</button>
    </div>
    <div class="seg" id="hands" role="radiogroup" aria-label="Hands">
      <button data-hands="both" role="radio">Both</button>
      <button data-hands="right" role="radio">Right</button>
      <button data-hands="left" role="radio">Left</button>
    </div>
    <span id="waitControls" class="group">
      <button id="restart">Restart</button>
    </span>
    <span id="tempoControls" class="group" hidden>
      <span class="zoom" role="group" aria-label="Speed">
        <button id="slower" aria-label="Slower">−</button>
        <output id="speed" class="speed"></output>
        <button id="faster" aria-label="Faster">+</button>
      </span>
      <button id="click" role="switch" aria-label="Metronome">🔔</button>
      <button id="latency" title="Latency calibration">⏱ 0 ms</button>
      <button id="startStop" class="primary">Start</button>
    </span>
    <span id="progress" class="progress"></span>
    <span id="feedback" class="feedback" aria-live="polite"></span>
    <span class="end">
      <button id="fullscreen" hidden>Full screen</button>
      <span id="midi" class="midi"></span>
      <a class="debug" href="${import.meta.env.BASE_URL}spike.html">MIDI debugger</a>
    </span>
  </header>
  <p id="status" class="status"></p>
  <p id="waitFeedback" class="wait-feedback" aria-live="polite" hidden></p>
  <div id="score" class="score"></div>
  <div id="strip" class="strip" hidden></div>
  <dialog id="calib" class="calib">
    <h2>Latency calibration</h2>
    <p>Play any key together with each click, as you would play along with the
    metronome. ${CALIBRATION.lead} clicks to get ready, then ${CALIBRATION.measured} are measured.</p>
    <p id="calibStatus" class="calib-status"></p>
    <div class="calib-buttons">
      <button id="calibGo" class="primary">Start</button>
      <button id="calibSave" disabled>Save</button>
      <button id="calibClose">Close</button>
    </div>
  </dialog>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const picker = $<HTMLSelectElement>('picker');
const status = $('status');
const score = $('score');
const feedback = $('feedback');
const waitFeedback = $('waitFeedback');
const startStop = $<HTMLButtonElement>('startStop');

// localStorage can throw (private mode, blocked storage); the app works without it.
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const oneOf = <T extends string>(options: readonly T[], value: string | null, fallback: T) =>
  options.find((o) => o === value) ?? fallback;

// Notation size is verovio's `scale`. Changing it re-flows the bars, so a larger
// size means fewer bars per line, never horizontal scrolling. Tune on the tablet.
const SCALE_MIN = 20, SCALE_MAX = 100, SCALE_STEP = 5;
let scale = Number(store.get('scale')) || 45;

// Practice speed, as a fraction of the score's tempo.
const SPEED_MIN = 0.4, SPEED_MAX = 1.5, SPEED_STEP = 0.05;
let speed = Number(store.get('speed')) || 1;

type Mode = 'wait' | 'tempo';
let mode: Mode = oneOf(['wait', 'tempo'], store.get('mode'), 'wait');
let hands: Hands = oneOf(['both', 'right', 'left'], store.get('hands'), 'both');

let entries: ScoreEntry[] = [];
let loaded: ScoreEntry | undefined;
let seq = 0;                        // drops a slow render superseded by a newer one
let laidOutWidth = 0;
let timing: ScoreTiming | undefined;
let practice: WaitMode | undefined;
let run: TempoRun | undefined;
let cursorMap: CursorMap | undefined;
let latencyMs = Number(store.get('latencyMs')) || 0;

// The last finished tempo run, kept for re-analysis and download.
type LastRun = { recording: NoteEvent[]; speed: number; latencyMs: number; recordedAt: string; untilMs: number };
let lastRun: LastRun | undefined;

const metronome = new Metronome();
metronome.enabled = store.get('click') !== 'off';

const review = new ReviewView({
  score,
  strip: $('strip'),
  load: () => { try { return JSON.parse(store.get('review') ?? '{}'); } catch { return {}; } },
  save: (settings) => store.set('review', JSON.stringify(settings)),
  realign: () => analyse(),
  download: downloadRun,
});

// ---- painting -------------------------------------------------------------

let noteEls = new Map<string, Element>();
let followedSystem: Element | null = null;

function paint() {
  const states = mode === 'wait' ? practice?.noteStates() : undefined;
  const inPlay = forHands(hands);
  const muted = new Set(timing?.events.filter((ev) => !inPlay(ev)).flatMap((ev) => [ev.id, ...ev.tiedIds]));
  for (const [id, el] of noteEls) {
    const s = states?.get(id);
    el.classList.toggle('hit', s === 'hit');
    el.classList.toggle('muted', muted.has(id));
  }
  $('progress').textContent = mode !== 'wait' || !practice ? ''
    : practice.done ? `Done · ${practice.wrong} wrong`
    : `${practice.cursor + 1} / ${practice.chords.length} · ${practice.wrong} wrong`;
}

// Bring a line of music to just below the sticky bar. Only when the line
// changes, so the page does not twitch.
function scrollToSystem(system: Element | null, force = false) {
  if (!system || (system === followedSystem && !force)) return;
  followedSystem = system;
  const barBottom = document.querySelector('.bar')!.getBoundingClientRect().bottom;
  const top = system.getBoundingClientRect().top;
  window.scrollBy({ top: top - barBottom - 12, behavior: 'smooth' });
}

function follow(force = false) {
  if (mode === 'tempo') {
    if (run) scrollToSystem(cursorSystem(), force);
    return;
  }
  const ev = practice?.current?.events[0];
  scrollToSystem(ev ? noteEls.get(ev.id)?.closest('g.system') ?? null : null, force);
}

function clearFeedback() {
  feedback.textContent = '';
  feedback.className = 'feedback';
}

// Wait mode's own feedback line, below the title — not the sticky header bar,
// so a long "wrong note" message never forces the toolbar to wrap and shift.
function clearWaitFeedback() {
  waitFeedback.textContent = '';
  waitFeedback.className = 'wait-feedback';
}

let flashTimer: number | undefined;
function flashWrong(f: Extract<Feedback, { kind: 'wrong' }>) {
  const want = f.expected.map(noteName).join(' ');
  waitFeedback.textContent = `${noteName(f.pitch)} — expected ${want}`;
  waitFeedback.className = 'wait-feedback wrong';
  const ids = new Set(practice?.current?.events
    .filter((e) => f.expected.includes(e.pitch)).flatMap((e) => [e.id, ...e.tiedIds]));
  for (const id of ids) noteEls.get(id)?.classList.add('wrong');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    for (const el of score.querySelectorAll('g.note.wrong')) el.classList.remove('wrong');
    if (waitFeedback.classList.contains('wrong')) clearWaitFeedback();   // unless replaced since
  }, 600);
}

// ---- wait mode --------------------------------------------------------------

function onNote(ev: NoteEvent) {
  if (calibrating) {
    if (ev.type === 'on') calibTaps.push(ev.t);
    return;
  }
  if (mode === 'tempo') {
    run?.record(ev);
    return;
  }
  if (!practice) return;
  const out = practice.handle(ev);
  if (out.length === 0) return;
  for (const f of out) {
    if (f.kind === 'wrong') flashWrong(f);
    else if (f.kind === 'done') { waitFeedback.textContent = 'Well played!'; waitFeedback.className = 'wait-feedback good'; }
  }
  paint();
  follow();
}

function restart() {
  stopRun();
  review.clear();
  lastRun = undefined;
  if (timing) practice = new WaitMode(timing.events, hands);
  clearWaitFeedback();
  paint();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  followedSystem = null;
}
$('restart').onclick = restart;

// ---- tempo mode -------------------------------------------------------------

const cursor = document.createElement('div');
cursor.className = 'cursor';
cursor.hidden = true;

function cursorSystem() {
  const pos = run && cursorMap?.position(Math.max(0, run.scoreTime()));
  return pos ? cursorMap!.systems[pos.system].el : null;
}

function drawCursor(scoreMs: number) {
  const pos = cursorMap?.position(scoreMs);
  cursor.hidden = !pos;
  if (!pos) return;
  cursor.style.height = `${pos.bottom - pos.top}px`;
  cursor.style.transform = `translate(${pos.x}px, ${pos.top}px)`;
}

let wakeLock: WakeLockSentinel | undefined;
let frame = 0;

async function startRun() {
  if (!timing || run) return;
  clearFeedback();
  review.clear();
  lastRun = undefined;
  await metronome.prepare();          // inside the tap: audio may start
  run = new TempoRun(timing, speed, latencyMs);
  metronome.play(run.clicks);
  followedSystem = null;
  wakeLock = await navigator.wakeLock?.request('screen').catch(() => undefined);
  startStop.textContent = 'Stop';
  startStop.classList.add('running');
  frame = requestAnimationFrame(tick);
}

function tick() {
  if (!run) return;
  const now = performance.now();
  const phase = run.phase(now);
  if (phase === 'finished') return finishRun();
  const t = run.scoreTime(now);
  drawCursor(Math.max(0, t));
  if (phase === 'countIn') {
    const left = run.countInLeft(now);
    feedback.textContent = left > 0 ? `${left}` : '';
    feedback.className = 'feedback count';
  } else if (feedback.classList.contains('count')) {
    clearFeedback();
  }
  follow();
  frame = requestAnimationFrame(tick);
}

function stopRun() {
  cancelAnimationFrame(frame);
  metronome.stop();
  run?.stop();
  run = undefined;
  wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
  startStop.textContent = 'Start';
  startStop.classList.remove('running');
  cursor.hidden = true;
  if (feedback.classList.contains('count')) clearFeedback();
}

function finishRun() {
  const finished = run;
  const reachedMusic = finished && finished.scoreTime() > 0;
  const untilMs = finished ? performance.now() - finished.t0 : 0;
  stopRun();
  if (!finished || !reachedMusic) return;
  lastRun = {
    recording: finished.recording, speed: finished.speed, untilMs,
    latencyMs: finished.latencyMs, recordedAt: new Date().toISOString(),
  };
  analyse();
  startStop.textContent = 'Play again';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Align the last run to the score with the current review settings.
function analyse() {
  if (!lastRun || !timing) return;
  const { maxOffsetBeats, reference } = review.settings;
  const { recording, speed: runSpeed, untilMs } = lastRun;
  review.show(align(timing.events, recording, runSpeed, { maxOffsetBeats, reference, hands, untilMs }), runSpeed);
}

function downloadRun() {
  if (!lastRun || !loaded || !timing) return;
  const data = { score: loaded.id, title: loaded.title, bpm: timing.bpm, hands, ...lastRun };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `${loaded.title} ${lastRun.recordedAt.slice(0, 16).replace(':', '')}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

startStop.onclick = () => (run ? finishRun() : startRun());

function setSpeed(next: number) {
  speed = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, next)) * 100) / 100;
  store.set('speed', String(speed));
  const bpm = timing ? ` · ${Math.round(timing.bpm * speed)} bpm` : '';
  $('speed').textContent = `${Math.round(speed * 100)} %${bpm}`;
}
$('slower').onclick = () => setSpeed(speed - SPEED_STEP);
$('faster').onclick = () => setSpeed(speed + SPEED_STEP);

const clickButton = $<HTMLButtonElement>('click');
function setClick(on: boolean) {
  metronome.enabled = on;
  store.set('click', on ? 'on' : 'off');
  clickButton.setAttribute('aria-checked', String(on));
  clickButton.textContent = on ? '🔔' : '🔕';
  clickButton.title = on ? 'Metronome on (count-in always clicks)' : 'Metronome off (count-in still clicks)';
}
clickButton.onclick = () => setClick(!metronome.enabled);
setClick(metronome.enabled);

// ---- latency calibration ----------------------------------------------------

const calib = $<HTMLDialogElement>('calib');
const calibStatus = $('calibStatus');
const latencyButton = $<HTMLButtonElement>('latency');
let calibrating = false;
let calibTaps: number[] = [];
let calibResult: number | undefined;

function showLatency() {
  latencyButton.textContent = `⏱ ${latencyMs} ms`;
}
showLatency();

latencyButton.onclick = () => {
  stopRun();
  calibStatus.textContent = `Current: ${latencyMs} ms`;
  $<HTMLButtonElement>('calibSave').disabled = true;
  calib.showModal();
};

$('calibGo').onclick = async () => {
  await metronome.prepare();
  const beat = 60000 / CALIBRATION.bpm;
  const start = performance.now() + 500;
  const total = CALIBRATION.lead + CALIBRATION.measured;
  const times = Array.from({ length: total }, (_, i) => start + i * beat);
  metronome.play(times.map((at, i) => ({ at, accent: i % 4 === 0, always: true })));
  calibTaps = [];
  calibResult = undefined;
  calibrating = true;
  $<HTMLButtonElement>('calibSave').disabled = true;
  calibStatus.textContent = 'Listen… then play along';
  setTimeout(() => {
    calibrating = false;
    const est = estimateLatency(times.slice(CALIBRATION.lead), calibTaps);
    if (!est) {
      calibStatus.textContent = 'Not enough key presses near the clicks. Try again.';
      return;
    }
    calibResult = est.latencyMs;
    calibStatus.textContent = `${est.latencyMs} ms (${est.taps} taps, spread ±${est.spreadMs} ms)`;
    $<HTMLButtonElement>('calibSave').disabled = false;
  }, times[total - 1] - performance.now() + beat);
};

$('calibSave').onclick = () => {
  if (calibResult === undefined) return;
  latencyMs = calibResult;
  store.set('latencyMs', String(latencyMs));
  showLatency();
  calib.close();
};
$('calibClose').onclick = () => { calibrating = false; metronome.stop(); calib.close(); };

// ---- mode and hands ---------------------------------------------------------

const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#modes button')];
function setMode(next: Mode) {
  stopRun();
  review.clear();
  lastRun = undefined;
  mode = next;
  store.set('mode', mode);
  for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('waitControls').hidden = mode !== 'wait';
  $('tempoControls').hidden = mode !== 'tempo';
  waitFeedback.hidden = mode !== 'wait';
  restart();
}
for (const b of modeButtons) b.onclick = () => setMode(b.dataset.mode as Mode);

// One hand only: the other staff greys out and is not asked for. Starts over.
const handButtons = [...document.querySelectorAll<HTMLButtonElement>('#hands button')];
function setHands(next: Hands) {
  hands = next;
  store.set('hands', hands);
  for (const b of handButtons) b.setAttribute('aria-checked', String(b.dataset.hands === hands));
  // Reviewing a run: just show the other hand's view of the same recording.
  if (mode === 'tempo' && lastRun && !run) { paint(); analyse(); }
  else restart();
}
for (const b of handButtons) b.onclick = () => setHands(b.dataset.hands as Hands);

// Space starts/stops a tempo run from a computer keyboard.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || mode !== 'tempo' || calib.open || (e.target as HTMLElement).matches('select, input')) return;
  e.preventDefault();
  startStop.click();
});

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
  if (!loaded || !timing) return;
  mine ??= ++seq;
  const width = score.clientWidth;
  const pages = await layoutScore(width, scale);
  if (mine !== seq) return;
  score.innerHTML = pages.join('');
  score.append(cursor);
  laidOutWidth = width;
  noteEls = new Map([...score.querySelectorAll('g.note')].map((el) => [el.id, el]));
  cursorMap = new CursorMap(score, timing);
  review.attach(noteEls, cursorMap);
  followedSystem = null;
  paint();
}

async function show(entry: ScoreEntry) {
  const mine = ++seq;
  stopRun();
  review.clear();
  lastRun = undefined;
  status.textContent = `Loading ${entry.title}…`;
  try {
    const t = await loadScore(entry);
    if (mine !== seq) return;
    loaded = entry;
    timing = t;
    practice = new WaitMode(timing.events, hands);
    setSpeed(speed);
    clearFeedback();
    clearWaitFeedback();
    await layout(mine);
    // A resize may have re-flowed meanwhile; that still shows this score.
    if (loaded !== entry) return;
    window.scrollTo(0, 0);
    status.textContent = entry.composer ? `${entry.title} — ${entry.composer}` : entry.title;
    store.set('score', entry.id);
  } catch (err) {
    if (mine !== seq && loaded !== entry) return;
    loaded = undefined;
    timing = undefined;
    practice = undefined;
    cursorMap = undefined;
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
    __run: () => run,
    __cursor: () => cursorMap,
    __review: () => review,
    // Feed a recording as if a run just finished, e.g. from a saved run file.
    __replay: (recording: NoteEvent[], runSpeed = speed) => {
      if (mode !== 'tempo') setMode('tempo');
      lastRun = { recording, speed: runSpeed, latencyMs: 0, recordedAt: new Date().toISOString(), untilMs: Infinity };
      analyse();
    },
    __timing: () => timing,
  });
}

// ---- start ----------------------------------------------------------------

setMode(mode);
setHands(hands);
setSpeed(speed);

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
