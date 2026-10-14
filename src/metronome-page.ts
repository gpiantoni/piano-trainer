// A standalone metronome for the phone: tempo, time signature, off-beats on or
// off. The same sounds as the trainer, from the same engine.
import './metronome.css';
import { Metronome, type Click } from './engine/metronome.ts';
import { beatsPerBar, subsPerBeat, type Meter } from './score/beats.ts';

const BPM_STEP = 5, BPM_MIN = 10, BPM_MAX = 240;
const METERS = ['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'] as const;
// Clicks are handed to the engine this far ahead; a change of tempo or meter
// takes effect from the first beat after that.
const AHEAD_MS = 400;
const FILL_MS = 50;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const clamp = (bpm: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm / BPM_STEP) * BPM_STEP));
const parse = (m: string): Meter => { const [count, unit] = m.split('/').map(Number); return { count, unit }; };

let bpm = clamp(Number(store.get('metronome.bpm')) || 80);
let meter: string = METERS.find((m) => m === store.get('metronome.meter')) ?? '4/4';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <section class="tempo">
    <span class="unit" id="unit"></span>
    <div class="dial">
      <button id="slower" aria-label="Slower">−</button>
      <output id="bpm"></output>
      <button id="faster" aria-label="Faster">+</button>
    </div>
    <span class="ms" id="ms"></span>
    <input id="slider" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="${BPM_STEP}" aria-label="Tempo">
  </section>
  <div class="meters" id="meters" role="radiogroup" aria-label="Time signature">
    ${METERS.map((m) => `<button role="radio" data-meter="${m}">${m}</button>`).join('')}
  </div>
  <button id="subdivide" class="toggle" role="switch">Off-beats</button>
  <div class="count" id="count"></div>
  <button id="start" class="start">Start</button>
`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = $<HTMLInputElement>('slider');
const count = $('count');
const startButton = $<HTMLButtonElement>('start');
const subdivideButton = $<HTMLButtonElement>('subdivide');

const metronome = new Metronome();
metronome.subdivide = store.get('metronome.subdivide') === 'on';

// ---- tempo ------------------------------------------------------------------

function setBpm(next: number) {
  bpm = clamp(next);
  store.set('metronome.bpm', String(bpm));
  $('bpm').textContent = String(bpm);
  $('ms').textContent = `${Math.round(60000 / bpm)} ms`;
  slider.value = String(bpm);
}
slider.oninput = () => setBpm(Number(slider.value));

// − and + step once on a tap and keep stepping while held.
function holdToRepeat(button: HTMLButtonElement, step: () => void) {
  let timer: number | undefined;
  const release = () => { clearTimeout(timer); timer = undefined; };
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    step();
    const repeat = (wait: number) => { timer = window.setTimeout(() => { step(); repeat(80); }, wait); };
    repeat(400);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) button.addEventListener(type, release);
  button.addEventListener('click', (e) => { if (e.detail === 0) step(); });   // keyboard
  button.addEventListener('contextmenu', (e) => e.preventDefault());       // long press on a phone
}
holdToRepeat($('slower'), () => setBpm(bpm - BPM_STEP));
holdToRepeat($('faster'), () => setBpm(bpm + BPM_STEP));

// ---- time signature and off-beats ---------------------------------------------

function setMeter(next: string) {
  meter = next;
  store.set('metronome.meter', meter);
  for (const b of $('meters').querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-checked', String(b.dataset.meter === meter));
  }
  const m = parse(meter);
  // The beat is a dotted quarter in 6/8, 9/8 and 12/8.
  $('unit').textContent = subsPerBeat(m) === 3 ? '♩. =' : '♩ =';
  if (!running) drawCount(m);
}
$('meters').onclick = (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (b?.dataset.meter) setMeter(b.dataset.meter);
};

function setSubdivide(on: boolean) {
  metronome.subdivide = on;
  store.set('metronome.subdivide', on ? 'on' : 'off');
  subdivideButton.setAttribute('aria-checked', String(on));
  subdivideButton.textContent = on ? '♫ Off-beats on' : '♩ Off-beats off';
  drawCount(running ? playing : parse(meter));
}
subdivideButton.onclick = () => setSubdivide(!metronome.subdivide);

// One mark per click in the bar: numbered beats, small circles for off-beats.
function drawCount(m: Meter) {
  const subs = subsPerBeat(m);
  count.innerHTML = Array.from({ length: beatsPerBar(m) * subs }, (_, i) =>
    i % subs ? '<span class="sub"></span>' : `<span>${i / subs + 1}</span>`).join('');
  for (const [i, el] of [...count.children].entries()) if (i % subs && !metronome.subdivide) el.setAttribute('hidden', '');
}

// ---- running ----------------------------------------------------------------

// Clicks are generated one step (beat or off-beat) at a time. Tempo and meter
// are read at each beat, so a change never splits a beat unevenly; a new meter
// starts on its downbeat.
let running = false;
let playing: Meter = parse(meter);
let nextAt = 0;          // performance.now() ms of the next step to generate
let pos = 0;             // its place in the bar, in steps
let stepMs = 0;
let fillTimer: number | undefined;
let frame = 0;
const sent: { at: number; pos: number }[] = [];   // for lighting the count

function fill() {
  const until = performance.now() + (document.hidden ? 3000 : AHEAD_MS);
  const clicks: Click[] = [];
  while (nextAt < until) {
    let subs = subsPerBeat(playing);
    if (pos % subs === 0) {
      if (meter !== `${playing.count}/${playing.unit}`) {
        playing = parse(meter);
        subs = subsPerBeat(playing);
        pos = 0;
        drawCount(playing);
      }
      stepMs = 60000 / bpm / subs;
    }
    clicks.push({ at: nextAt, accent: pos === 0, always: true, sub: pos % subs !== 0 });
    sent.push({ at: nextAt, pos });
    nextAt += stepMs;
    pos = (pos + 1) % (beatsPerBar(playing) * subs);
  }
  if (clicks.length) metronome.extend(clicks);
}

function light() {
  const now = performance.now();
  while (sent.length > 1 && sent[1].at <= now) sent.shift();
  const heard = sent[0] && sent[0].at <= now ? sent[0].pos : -1;
  [...count.children].forEach((el, i) => el.classList.toggle('now', i === heard));
  frame = requestAnimationFrame(light);
}

async function start() {
  await metronome.prepare();          // inside the tap: audio may start
  metronome.play([]);
  running = true;
  playing = parse(meter);
  pos = 0;
  nextAt = performance.now() + 100;
  sent.length = 0;
  drawCount(playing);
  fill();
  fillTimer = window.setInterval(fill, FILL_MS);
  frame = requestAnimationFrame(light);
  count.classList.add('live');
  startButton.textContent = 'Stop';
  startButton.classList.add('running');
  keepAwake();
}

function stop() {
  running = false;
  clearInterval(fillTimer);
  cancelAnimationFrame(frame);
  metronome.stop();
  count.classList.remove('live');
  for (const el of count.children) el.classList.remove('now');
  drawCount(parse(meter));
  startButton.textContent = 'Start';
  startButton.classList.remove('running');
  keepAwake();
}

startButton.onclick = () => (running ? stop() : start());
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    startButton.click();
  }
});

// The screen stays on while it plays. The browser drops the lock whenever the
// page is hidden, so it is taken again on return.
let wakeLock: Promise<WakeLockSentinel | undefined> | undefined;
function keepAwake() {
  const want = document.visibilityState === 'visible' && running;
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

setBpm(bpm);
setMeter(meter);
setSubdivide(metronome.subdivide);
