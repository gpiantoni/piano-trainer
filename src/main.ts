import './style.css';
import { fetchBundled, fetchManifest, layoutScore, loadScore, type ScoreEntry } from './score/load.ts';
import type { ScoreTiming } from './score/timeline.ts';
import { CursorMap } from './score/cursor.ts';
import { listenMidi } from './midi/input.ts';
import { WaitMode, forHands, noteName, type Feedback } from './engine/waitMode.ts';
import { Metronome } from './engine/metronome.ts';
import { TempoRun } from './engine/tempoRun.ts';
import { OFFSET_MIN_NOTES, align, runOffset } from './engine/align.ts';
import { analyseFollow, fewestErrors } from './engine/follow.ts';
import { CALIBRATION, estimateLatency } from './engine/calibration.ts';
import { ReviewView } from './review/view.ts';
import { WIDEST_WINDOW } from './review/palettes.ts';
import type { Hands, NoteEvent } from './types.ts';
import { getScore, listScores } from './library/db.ts';
import { LibraryDialog } from './library/dialog.ts';
import {
  formatSection, inWindow, parseSection, playWindow, sectionFrom, sectionLabel,
  type Click, type PlayWindow, type Section,
} from './score/section.ts';
import { lastAtOrBefore } from './score/beats.ts';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="bar">
    <div class="row">
      <span class="group l">
        <select id="picker" aria-label="Score"></select>
        <button id="library">Library</button>
      </span>
      <span class="group m">
        <div class="seg" id="modes" role="radiogroup" aria-label="Mode">
          <button data-mode="wait" role="radio">Wait</button>
          <button data-mode="follow" role="radio">Follow</button>
          <button data-mode="tempo" role="radio">Tempo</button>
        </div>
        <div class="seg" id="hands" role="radiogroup" aria-label="Hands">
          <button data-hands="both" role="radio">Both</button>
          <button data-hands="left" role="radio">Left</button>
          <button data-hands="right" role="radio">Right</button>
        </div>
        <span class="group">
          <button id="bars" title="Practise some bars: tap the first bar, then the last">Bars</button>
          <button id="barsClear" aria-label="Whole piece" title="Whole piece" hidden>✕</button>
        </span>
      </span>
      <span class="group r">
        <button id="fullscreen" hidden>Full screen</button>
        <div class="zoom" role="group" aria-label="Notation size">
          <button id="zoomOut" aria-label="Smaller">−</button>
          <output id="zoomLevel"></output>
          <button id="zoomIn" aria-label="Larger">+</button>
        </div>
        <span id="midi" class="midi"></span>
      </span>
    </div>
    <div class="row">
      <span class="group l">
        <span id="tempoControls" class="group" hidden>
          <span class="zoom" role="group" aria-label="Speed">
            <button id="slower" aria-label="Slower">−</button>
            <output id="speed" class="speed"></output>
            <button id="faster" aria-label="Faster">+</button>
          </span>
          <button id="click" role="switch" aria-label="Metronome">🔔</button>
          <button id="subdivide" role="switch" aria-label="Eighth-note click">♩</button>
          <button id="latency" title="Latency calibration">⏱ 0 ms</button>
        </span>
      </span>
      <span class="m">
        <span id="count" class="count" aria-hidden="true"></span>
        <span id="progress" class="progress"></span>
      </span>
      <span class="group r">
        <button id="restart">Restart</button>
        <button id="startStop" class="primary" hidden>Start</button>
      </span>
    </div>
  </header>
  <p id="status" class="status"></p>
  <p id="barsHint" class="status hint" aria-live="polite" hidden></p>
  <p id="libHint" class="status hint" hidden>Add your own scores: <b>Library</b> → Add files or Link folder.</p>
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
      <button id="calibRun" hidden></button>
      <button id="calibClose">Close</button>
    </div>
  </dialog>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const picker = $<HTMLSelectElement>('picker');
const status = $('status');
const score = $('score');
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

// Practice tempo in beats per minute, where a beat is the meter's pulse (a
// dotted quarter in 6/8), remembered per score. −/+ step to the next multiple
// of BPM_STEP; the score's own tempo is the default. The engine takes `speed`,
// the practice tempo as a fraction of the score's.
const BPM_STEP = 5, BPM_MIN = 10, SPEED_MAX = 1.5;
let practiceBpm = 0;
let speed = 1;

type Mode = 'wait' | 'follow' | 'tempo';
let mode: Mode = oneOf(['wait', 'follow', 'tempo'], store.get('mode'), 'wait');
let hands: Hands = oneOf(['both', 'right', 'left'], store.get('hands'), 'both');

let entries: ScoreEntry[] = [];
let loaded: ScoreEntry | undefined;
let seq = 0;                        // drops a slow render superseded by a newer one
let laidOutWidth = 0;
let timing: ScoreTiming | undefined;
let practice: WaitMode | undefined;
let run: TempoRun | undefined;
// A Follow run: played like wait mode, every event recorded (t in real ms from
// its first) and timed afterwards. `down`: keys held now; the run ends when the
// last chord is done and they are all up.
let followRun: { t0: number; recording: NoteEvent[]; down: Set<number> } | undefined;
let cursorMap: CursorMap | undefined;
let latencyMs = Number(store.get('latencyMs')) || 0;
let section: Section | undefined;   // some bars only; remembered per score

// The last finished tempo or Follow run, kept for re-analysis and download.
type LastRun = {
  mode: 'tempo' | 'follow';
  recording: NoteEvent[]; speed: number; latencyMs: number; recordedAt: string; untilMs: number;
  window: PlayWindow;
};
let lastRun: LastRun | undefined;
// Its median timing offset (real ms, after latencyMs), as re-center uses it.
let lastOffset: ReturnType<typeof runOffset> | undefined;
// A Follow run's bpm with the fewest errors, for the criterion it was found at.
let bestOf: { run: NoteEvent[]; within: number; best: ReturnType<typeof fewestErrors> } | undefined;

const metronome = new Metronome();
metronome.enabled = store.get('click') !== 'off';
metronome.subdivide = store.get('subdivide') === 'on';

const review = new ReviewView({
  score,
  strip: $('strip'),
  load: () => { try { return JSON.parse(store.get('review') ?? '{}'); } catch { return {}; } },
  save: (settings) => store.set('review', JSON.stringify(settings)),
  realign: () => analyse(),
  download: downloadRun,
  setBpm: (bpm) => { setBpm(bpm); retime(); },
});

// ---- painting -------------------------------------------------------------

let noteEls = new Map<string, Element>();
let followedSystem: Element | null = null;

function paint() {
  // Follow plays like wait mode; its review replaces the greens.
  const states = mode === 'wait' || (mode === 'follow' && !review.active) ? practice?.noteStates() : undefined;
  const inPlay = forHands(hands);
  const w = timing && playWindow(timing, section);
  const muted = new Set(timing?.events
    .filter((ev) => !inPlay(ev) || !inWindow(w!, ev.onMs))
    .flatMap((ev) => [ev.id, ...ev.tiedIds]));
  for (const [id, el] of noteEls) {
    const s = states?.get(id);
    el.classList.toggle('hit', s === 'hit');
    el.classList.toggle('muted', muted.has(id));
  }
  $('progress').textContent = mode === 'tempo' || !practice ? ''
    : practice.done ? `Done · ${practice.wrong} wrong`
    : `${practice.cursor} / ${practice.chords.length} played · ${practice.wrong} wrong`;
  drawCount();
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

function scrollToCurrent(force = false) {
  if (mode === 'tempo') {
    if (run) scrollToSystem(cursorSystem(), force);
    return;
  }
  const ev = practice?.current?.events[0];
  scrollToSystem(ev ? noteEls.get(ev.id)?.closest('g.system') ?? null : null, force);
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
  if (mode === 'follow') {
    // A run starts from the top. Reviewing: nothing until Restart. A run cut
    // short without a review (Bars, Library): the next key starts over.
    if (!followRun && review.active) return;
    if (!followRun && (practice.cursor > 0 || practice.wrong > 0)) restart();
    if (!recordFollow(ev)) return;
  }
  const out = practice.handle(ev);
  // Follow ends once the last chord is let go, so its durations are measured.
  if (mode === 'follow' && practice.done && followRun?.down.size === 0) return finishFollow();
  if (out.length === 0) return;
  // The end needs no message: the progress already reads "Done · N wrong".
  for (const f of out) if (f.kind === 'wrong') flashWrong(f);
  paint();
  scrollToCurrent();
}

// ---- follow mode ------------------------------------------------------------

// Records one event of a Follow run; the first key or pedal down starts it.
// False: not part of a run (a key-up left over from before).
function recordFollow(ev: NoteEvent): boolean {
  if (!followRun) {
    if (ev.type === 'off' || (ev.type === 'pedal' && !ev.down)) return false;
    followRun = { t0: ev.t, recording: [], down: new Set() };
    startStop.textContent = 'Stop';
    startStop.classList.add('running');
    startStop.hidden = false;
    keepAwake();
  }
  followRun.recording.push({ ...ev, t: ev.t - followRun.t0 });
  if (ev.type === 'on') followRun.down.add(ev.pitch);
  else if (ev.type === 'off') followRun.down.delete(ev.pitch);
  return true;
}

// The last chord let go, or Stop: review the chords played so far.
function finishFollow() {
  const finished = followRun;
  stopRun();
  if (!finished || !timing || !practice) return;
  if (practice.completions.length === 0) return restart();
  lastRun = {
    mode: 'follow', recording: finished.recording, speed, untilMs: Infinity,
    latencyMs: 0, recordedAt: new Date().toISOString(), window: playWindow(timing, section),
  };
  analyse();
  paint();
  scrollToStart();
}

// The notes wait mode asks for: the section's, or the whole piece.
function practiceEvents(t: ScoreTiming) {
  const w = playWindow(t, section);
  return t.events.filter((ev) => inWindow(w, ev.onMs));
}

// Back to where playing starts: the top, or the line with the section's first bar.
function scrollToStart() {
  followedSystem = null;
  const first = section && timing?.measures[section.from];
  const system = first && document.getElementById(first.id)?.closest('g.system');
  if (system) scrollToSystem(system, true);
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

function restart() {
  stopRun();
  review.clear();
  lastRun = undefined;
  if (timing) practice = new WaitMode(practiceEvents(timing), hands);
  clearWaitFeedback();
  paint();
  scrollToStart();
}
$('restart').onclick = restart;

// ---- sections: some bars only ----------------------------------------------

const barsButton = $<HTMLButtonElement>('bars');
const barsHint = $('barsHint');
const barMark = Object.assign(document.createElement('div'), { className: 'bar-mark', hidden: true });

// Picking a section: undefined when not picking; `first` after the first tap.
let picking: { first?: number } | undefined;

function showSection() {
  barsButton.textContent = section && timing ? sectionLabel(timing, section) : 'Bars';
  barsButton.setAttribute('aria-pressed', String(!!picking));
  $('barsClear').hidden = !section;
  barsHint.hidden = !picking;
  barsHint.textContent = !picking ? ''
    : picking.first === undefined ? 'Tap the first bar of the section.'
    : `${sectionLabel(timing!, { from: picking.first, to: picking.first })} — now tap the last bar.`;
}

function setSection(next: Section | undefined) {
  section = next;
  if (loaded) store.set(`section:${loaded.id}`, next ? formatSection(next) : '');
  showSection();
  restart();
}

function endPicking() {
  picking = undefined;
  barMark.hidden = true;
  showSection();
}

// The bar under a tap. Taps land on white paper as often as on ink, so test
// against each bar's box (staves only, plus some room above and below) rather
// than the element that was hit.
function measureAt(x: number, y: number): number {
  let best = -1, bestDist = Infinity;
  timing?.measures.forEach((m, i) => {
    const r = staffBox(document.getElementById(m.id));
    if (!r || x < r.left || x > r.right) return;
    const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (dist < 60 && dist < bestDist) { best = i; bestDist = dist; }
  });
  return best;
}

function staffBox(el: Element | null) {
  if (!el) return undefined;
  const staves = [...el.querySelectorAll(':scope > g.staff')].map((s) => s.getBoundingClientRect());
  if (staves.length === 0) return el.getBoundingClientRect();
  return {
    left: Math.min(...staves.map((s) => s.left)), right: Math.max(...staves.map((s) => s.right)),
    top: Math.min(...staves.map((s) => s.top)), bottom: Math.max(...staves.map((s) => s.bottom)),
  };
}

// Positions `div` over a measure's staves, with some room above and below.
function placeOverMeasure(div: HTMLElement, m: { id: string } | undefined) {
  const r = m && staffBox(document.getElementById(m.id));
  div.hidden = !r;
  if (!r) return;
  const base = score.getBoundingClientRect();
  Object.assign(div.style, {
    left: `${r.left - base.left}px`, top: `${r.top - base.top - 8}px`,
    width: `${r.right - r.left}px`, height: `${r.bottom - r.top + 16}px`,
  });
}

function placeBarMark() {
  placeOverMeasure(barMark, picking?.first !== undefined ? timing?.measures[picking.first] : undefined);
}

barsButton.onclick = () => {
  if (picking) return endPicking();
  if (!timing) return;
  stopRun();
  review.clear();
  lastRun = undefined;
  picking = {};
  showSection();
};
$('barsClear').onclick = () => { endPicking(); setSection(undefined); };

// Capture phase: while picking, a tap chooses a bar and does nothing else
// (no review popover).
score.addEventListener('click', (e) => {
  if (!picking) return;
  e.stopPropagation();
  const i = measureAt(e.clientX, e.clientY);
  if (i < 0) return;
  if (picking.first === undefined) {
    picking.first = i;
    placeBarMark();
    showSection();
    return;
  }
  const next = sectionFrom(picking.first, i);
  endPicking();
  setSection(next);
}, true);

// ---- tempo mode -------------------------------------------------------------

// Tempo-mode indicator: a subtle fill over the whole bar being played, rather
// than a moving line — a line implies a within-bar tempo the notes themselves
// don't have (durations vary), which reads as more precise than it is.
const cursor = Object.assign(document.createElement('div'), { className: 'bar-highlight', hidden: true });

function cursorSystem() {
  const pos = run && cursorMap?.position(Math.max(run.window.startMs, run.scoreTime()));
  return pos ? cursorMap!.systems[pos.system].el : null;
}

function drawCursor(scoreMs: number) {
  const i = timing ? lastAtOrBefore(timing.measures, scoreMs, (m) => m.startMs) : -1;
  placeOverMeasure(cursor, i >= 0 ? timing!.measures[i] : undefined);
}

// The count-in as a fixed row of beat numbers, with the eighths between them
// as dots while the eighth-note click is on. The click just heard lights up, so
// nothing shifts; before a run the row shows how long the count-in will be.
const count = $('count');
let countClicks: Click[] = [];

function drawCount() {
  const clicks = mode === 'tempo' && timing ? playWindow(timing, section).countIn : [];
  countClicks = clicks.filter((c) => !c.sub || metronome.subdivide).sort((a, b) => a.t - b.t);
  let beat = 0;
  count.replaceChildren(...countClicks.map((c) => Object.assign(document.createElement('span'),
    c.sub ? { className: 'sub' } : { textContent: String(++beat) })));
  lightCount(undefined);
}

// `i`: the click just heard (-1 before the first); undefined outside a count-in.
function lightCount(i: number | undefined) {
  count.classList.toggle('live', i !== undefined);
  [...count.children].forEach((el, k) => el.classList.toggle('now', k === i));
}

// The screen stays on during a run and in full screen, where the tablet sits on
// the stand untouched between runs and while wait mode waits. The browser drops
// the lock whenever the page is hidden, so it is taken again on return.
let wakeLock: Promise<WakeLockSentinel | undefined> | undefined;
function keepAwake() {
  const want = document.visibilityState === 'visible'
    && (run !== undefined || followRun !== undefined || document.fullscreenElement !== null);
  if (want && !wakeLock) {
    const lock = navigator.wakeLock?.request('screen').catch(() => undefined);
    wakeLock = lock;
    lock?.then((s) => s?.addEventListener('release', () => { if (wakeLock === lock) wakeLock = undefined; }));
  } else if (!want && wakeLock) {
    wakeLock.then((s) => s?.release()).catch(() => undefined);
    wakeLock = undefined;
  }
}
document.addEventListener('visibilitychange', keepAwake);

let frame = 0;

async function startRun() {
  if (!timing || run) return;
  review.clear();
  lastRun = undefined;
  await metronome.prepare();          // inside the tap: audio may start
  run = new TempoRun(timing, speed, latencyMs, playWindow(timing, section));
  metronome.play(run.clicks);
  followedSystem = null;
  keepAwake();
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
  drawCursor(Math.max(run.window.startMs, t));
  lightCount(phase === 'countIn' ? lastAtOrBefore(countClicks, now, (c) => run!.realAt(c.t)) : undefined);
  scrollToCurrent();
  frame = requestAnimationFrame(tick);
}

function stopRun() {
  cancelAnimationFrame(frame);
  metronome.stop();
  run?.stop();
  run = undefined;
  followRun = undefined;
  keepAwake();
  startStop.textContent = 'Start';
  startStop.classList.remove('running');
  if (mode === 'follow') startStop.hidden = true;   // shown only while a Follow run plays
  cursor.hidden = true;
  lightCount(undefined);
}

function finishRun() {
  const finished = run;
  const reachedMusic = finished && finished.scoreTime() > finished.window.startMs;
  const untilMs = finished ? performance.now() - finished.t0 : 0;
  stopRun();
  if (!finished || !reachedMusic) return;
  lastRun = {
    mode: 'tempo', recording: finished.recording, speed: finished.speed, untilMs,
    latencyMs: finished.latencyMs, recordedAt: new Date().toISOString(), window: finished.window,
  };
  analyse();
  startStop.textContent = 'Play again';
  scrollToStart();
}

// Align the last run to the score with the current review settings. First a
// pass at the widest match window, centred on the score, finds this run's own
// median timing offset; then, with re-center on, the chosen window is centred
// on that offset before it decides what counts as played. The offset comes
// from the run, not from the chosen window.
function analyse() {
  if (!lastRun || !timing) return;
  if (lastRun.mode === 'follow') {
    // Untimed restarts instead of a run-wide offset: no re-center.
    const { recording, speed: runSpeed, window } = lastRun;
    const events = timing.events.filter((ev) => inWindow(window, ev.onMs));
    const opts = { hands, window, pauseBeats: review.window };
    const a = analyseFollow(events, recording, runSpeed, opts, timing.pedals);
    lastOffset = undefined;
    const base = scoreBpm(timing), bpm = runSpeed * base;
    // Every bpm the −/+ can reach, and the one the run is timed at. Only the
    // criterion changes the answer: kept until it does.
    const within = review.settings.within;
    if (bestOf?.run !== lastRun.recording || bestOf.within !== within) {
      const bpms = [...bpmSteps(base), bpm];
      bestOf = { run: lastRun.recording, within, best: fewestErrors(events, recording, opts, within, bpms, base, bpm) };
    }
    review.show(a, runSpeed, { ms: undefined, notes: 0 }, { bpm, best: bestOf.best });
    return;
  }
  const { recenter } = review.settings;
  const maxOffsetBeats = review.window;
  const { recording, speed: runSpeed, untilMs, window } = lastRun;
  const base = { hands, untilMs, window };
  const widest = WIDEST_WINDOW;
  const wide = align(timing.events, recording, runSpeed, { ...base, maxOffsetBeats: widest }, timing.pedals);
  const offset = runOffset(wide);
  lastOffset = offset;
  const biasMs = recenter ? offset.ms ?? 0 : 0;
  const chosen = biasMs === 0 && maxOffsetBeats === widest
    ? wide
    : align(timing.events, recording, runSpeed, { ...base, maxOffsetBeats, biasMs }, timing.pedals);
  review.show(chosen, runSpeed, offset);
}

function downloadRun() {
  if (!lastRun || !loaded || !timing) return;
  const bars = lastRun.window.section ? sectionLabel(timing, lastRun.window.section) : 'all';
  const data = { score: loaded.id, title: loaded.title, bpm: timing.bpm, hands, bars, ...lastRun };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `${loaded.title} ${lastRun.recordedAt.slice(0, 16).replace(':', '')}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

startStop.onclick = () => (mode === 'follow' ? finishFollow() : run ? finishRun() : startRun());

// The score's own tempo in beats per minute, at its start. `bpm` is the exact
// quarter-note tempo; beatMs is rounded to whole ms, so use it only for the beat
// unit (½, 1, 1½, 2… quarters) rather than dividing by it (110 → 110.09).
function scoreBpm(t: ScoreTiming) {
  const beatMs = t.events[0]?.beatMs;
  const quarters = beatMs ? Math.max(0.25, Math.round((beatMs * t.bpm) / 60000 * 4) / 4) : 1;
  return t.bpm / quarters;
}

// The practice tempo's range: multiples of BPM_STEP up to SPEED_MAX × the score's.
function bpmRange(base: number) {
  const lo = Math.max(BPM_STEP, BPM_MIN);
  return { lo, hi: Math.max(Math.floor((base * SPEED_MAX) / BPM_STEP) * BPM_STEP, lo) };
}
function bpmSteps(base: number) {
  const { lo, hi } = bpmRange(base);
  return Array.from({ length: (hi - lo) / BPM_STEP + 1 }, (_, i) => lo + i * BPM_STEP);
}

function setBpm(next: number) {
  const output = $('speed');
  if (!timing || !loaded) { output.textContent = '— bpm'; return; }
  const base = scoreBpm(timing);
  const { lo, hi } = bpmRange(base);
  practiceBpm = Math.min(Math.max(next, lo), hi);
  speed = practiceBpm / base;
  store.set(`bpm:${loaded.id}`, String(practiceBpm));
  output.textContent = `${Math.round(practiceBpm)} bpm · ${Math.round(speed * 100)} % · ${Math.round(60000 / practiceBpm)} ms`;
  output.title = `Practice tempo · % of the score's ${Math.round(base)} bpm · one beat`;
}
// 72 → 75 → 80 up, 72 → 70 → 65 down. The tolerance absorbs float noise in the
// score's tempo (110.0000001 must step down to 105, not to 110).
const steps = (bpm: number) => bpm / BPM_STEP;
$('slower').onclick = () => { setBpm((Math.ceil(steps(practiceBpm) - 1e-6) - 1) * BPM_STEP); retime(); };
$('faster').onclick = () => { setBpm((Math.floor(steps(practiceBpm) + 1e-6) + 1) * BPM_STEP); retime(); };

// A Follow run's clock exists only in its review: at another bpm, time it again.
// A tempo run keeps the bpm it was played at.
function retime() {
  if (lastRun?.mode !== 'follow') return;
  lastRun = { ...lastRun, speed };
  analyse();
}

const clickButton = $<HTMLButtonElement>('click');
function setClick(on: boolean) {
  metronome.enabled = on;
  store.set('click', on ? 'on' : 'off');
  clickButton.setAttribute('aria-checked', String(on));
  clickButton.textContent = on ? '🔔' : '🔕';
  clickButton.title = on ? 'Metronome on (count-in always clicks)' : 'Metronome off (count-in still clicks)';
}
clickButton.onclick = () => setClick(!metronome.enabled);

const subdivideButton = $<HTMLButtonElement>('subdivide');
function setSubdivide(on: boolean) {
  metronome.subdivide = on;
  store.set('subdivide', on ? 'on' : 'off');
  subdivideButton.setAttribute('aria-checked', String(on));
  subdivideButton.textContent = on ? '♫' : '♩';
  subdivideButton.title = on ? 'Eighth-note click on' : 'Eighth-note click off';
  drawCount();
}
subdivideButton.onclick = () => setSubdivide(!metronome.subdivide);
setClick(metronome.enabled);
setSubdivide(metronome.subdivide);

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

// The last run's own offset on top of the latency it was recorded with: what
// re-center would zero on, kept as the latency for the runs after it.
const calibRun = $<HTMLButtonElement>('calibRun');
const fromRun = () => (lastRun && lastOffset?.ms !== undefined ? Math.round(lastRun.latencyMs + lastOffset.ms) : undefined);

latencyButton.onclick = () => {
  stopRun();
  calibStatus.textContent = `Current: ${latencyMs} ms`;
  $<HTMLButtonElement>('calibSave').disabled = true;
  const next = fromRun();
  calibRun.hidden = !lastRun;
  calibRun.disabled = next === undefined;
  calibRun.textContent = next === undefined ? 'From last run' : `From last run: ${next} ms`;
  calibRun.title = next === undefined
    ? `Needs ≥ ${OFFSET_MIN_NOTES} timed notes (the last run has ${lastOffset?.notes ?? 0})`
    : `The last run's median offset (${Math.round(lastOffset!.ms!)} ms) added to the ${lastRun!.latencyMs} ms it was recorded with: the re-center value`;
  calib.showModal();
};

calibRun.onclick = () => {
  const next = fromRun();
  if (next === undefined || !lastRun) return;
  // Re-read the last run as if it had been recorded with the new latency.
  const shift = next - lastRun.latencyMs;
  lastRun = { ...lastRun, latencyMs: next, recording: lastRun.recording.map((ev) => ({ ...ev, t: ev.t - shift })) };
  latencyMs = next;
  store.set('latencyMs', String(latencyMs));
  showLatency();
  calib.close();
  analyse();
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
  $('restart').hidden = mode === 'tempo';
  // Follow keeps the bpm only: no metronome, and latency cancels out.
  $('tempoControls').hidden = mode === 'wait';
  for (const id of ['click', 'subdivide', 'latency']) $(id).hidden = mode !== 'tempo';
  startStop.hidden = mode !== 'tempo';
  waitFeedback.hidden = mode === 'tempo';
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

// Space starts/stops a tempo run, or stops a Follow run, from a computer keyboard.
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && picking) { endPicking(); return; }
  if (e.code !== 'Space' || mode === 'wait' || picking || calib.open || library.dialog.open || (e.target as HTMLElement).matches('select, input')) return;
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
    keepAwake();
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
  score.append(cursor, barMark);
  placeBarMark();
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
    const data = entry.source === 'bundled' ? await fetchBundled(entry.path) : (await getScore(entry.id))?.data;
    if (!data) throw new Error('it is no longer in the library');
    if (mine !== seq) return;
    const t = await loadScore(data, entry.title);
    if (mine !== seq) return;
    loaded = entry;
    timing = t;
    section = parseSection(store.get(`section:${entry.id}`), t.measures.length);
    showSection();
    practice = new WaitMode(practiceEvents(t), hands);
    setBpm(Number(store.get(`bpm:${entry.id}`)) || scoreBpm(timing));
    clearWaitFeedback();
    await layout(mine);
    // A resize may have re-flowed meanwhile; that still shows this score.
    if (loaded !== entry) return;
    window.scrollTo(0, 0);
    if (section) scrollToStart();
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
  layout().then(() => scrollToCurrent(true));
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
    if (score.clientWidth !== laidOutWidth) layout().then(() => scrollToCurrent(true));
  }, 150);
}).observe(score);

picker.onchange = () => {
  const entry = entries.find((e) => e.id === picker.value);
  if (entry) show(entry);
};

// ---- library ----------------------------------------------------------------

let bundled: ScoreEntry[] = [];

// Scores from the device first (they are the point of the app), then built-in.
async function refreshEntries() {
  let device: ScoreEntry[] = [];
  try {
    device = (await listScores())
      .map((s): ScoreEntry => ({
        id: s.id, title: s.title, composer: s.composer,
        source: 'device', missing: s.missing, updatedAt: s.updatedAt,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  } catch (err) {
    status.textContent = `Could not open the library: ${(err as Error).message}`;
  }
  entries = [...device, ...bundled];

  const option = (e: ScoreEntry) => {
    const label = e.composer ? `${e.title} (${e.composer})` : e.title;
    return new Option(e.source === 'device' && e.missing ? `${label} (not in folder)` : label, e.id);
  };
  const group = (label: string, list: ScoreEntry[]) => {
    const g = Object.assign(document.createElement('optgroup'), { label });
    g.append(...list.map(option));
    return g;
  };
  picker.replaceChildren(
    ...(device.length ? [group('On this device', device)] : []),
    ...(bundled.length ? [group('Built in', bundled)] : []),
  );
  if (loaded) picker.value = loaded.id;
  $('libHint').hidden = device.length > 0;
}

const library = new LibraryDialog(async () => {
  await refreshEntries();
  if (!loaded) {
    if (entries[0]) { picker.value = entries[0].id; show(entries[0]); }
    return;
  }
  const now = entries.find((e) => e.id === loaded!.id);
  // The score on screen was removed, or re-imported with changes: show the new state.
  if (!now) {
    const next = entries[0];
    if (next) { picker.value = next.id; show(next); }
    return;
  }
  const changed = now.source === 'device' && loaded.source === 'device' && now.updatedAt !== loaded.updatedAt;
  if (changed && !run) show(now);
  else loaded = now;
});
$('library').onclick = () => { stopRun(); library.open(); };

// ---- MIDI -----------------------------------------------------------------

listenMidi(onNote, (s) => {
  const midi = $('midi');
  midi.className = `midi ${s.kind === 'ready' && s.inputs.length ? 'ok' : 'bad'}`;
  midi.textContent =
    s.kind === 'unsupported' ? 'No Web MIDI — use Chrome'
    : s.kind === 'denied' ? 'MIDI blocked'
    : s.inputs.length ? `🎹 ${s.inputs.join(', ')}`
    : 'No piano connected';
  midi.title = s.kind === 'denied' ? s.message : midi.textContent;
});

// Dev only: play without a piano from the console.
if (import.meta.env.DEV) {
  Object.assign(window, {
    // `__play(57, 60, 64)` presses the keys together, then lets them go.
    __play: (...pitches: number[]) => {
      for (const pitch of pitches) onNote({ type: 'on', pitch, velocity: 64, t: performance.now() });
      for (const pitch of pitches) onNote({ type: 'off', pitch, velocity: 0, t: performance.now() });
    },
    __practice: () => practice,
    __run: () => run,
    __cursor: () => cursorMap,
    __review: () => review,
    // Feed a recording as if a run just finished, e.g. from a saved run file.
    // `untilMs` (real ms from t0) simulates stopping a tempo run early.
    __replay: (recording: NoteEvent[], runSpeed = speed, untilMs = Infinity, runMode: 'tempo' | 'follow' = 'tempo') => {
      if (mode !== runMode) setMode(runMode);
      if (!timing) return;
      lastRun = {
        mode: runMode, recording, speed: runSpeed, latencyMs: 0, recordedAt: new Date().toISOString(), untilMs,
        window: playWindow(timing, section),
      };
      analyse();
      paint();
    },
    __timing: () => timing,
  });
}

// ---- start ----------------------------------------------------------------

setMode(mode);
setHands(hands);
setBpm(0);

try {
  bundled = await fetchManifest();
} catch (err) {
  status.textContent = `Could not load the built-in score list: ${(err as Error).message}`;
}
await refreshEntries();

const initial = entries.find((e) => e.id === store.get('score'))
  ?? entries.find((e) => e.title === 'Minuet in G')
  ?? entries[0];
if (initial) {
  picker.value = initial.id;
  show(initial);
}
