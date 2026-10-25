import type { ExpectedEvent, Extra, Hands, NoteEvent, PedalMark, PlayedNote } from '../types.ts';
import { DEFAULT_ALIGN, alignPedal, keyPresses, pedalPresses, type Alignment } from './align.ts';
import { WaitMode, type Completion } from './waitMode.ts';
import { beatsPerBar, lastAtOrBefore, type Meter } from '../score/beats.ts';

// After a Follow run: played like wait mode, timed afterwards against a clock at
// the practice speed, never nudged towards the player, so drift shows. A chord
// later than the match window is a pause: the clock restarts there.
//
// Each stretch (from the first chord, or from a pause) starts its clock on its
// first chord. Once a bar of it has been played, the clock is moved once, to
// the median offset of the chords in that bar, so one odd chord at the start
// doesn't shift everything after it. The tempo stays the set one. A stretch
// that ends within its first bar keeps the clock on its first chord, which is
// then untimed. Pure: no DOM, no clock.

export type FollowOptions = {
  hands: Hands;
  window: { startMs: number; endMs: number };   // the section, as in align; only the pedal needs it
  pauseBeats: number;                            // later than this (× beat) is a pause: the review's match window
  measures?: { meter: Meter }[];                 // by bar index: how long a bar is; 4/4 if missing
};

// A stretch of playing: where it started (real ms, the first key of its first
// chord), and its clock, a line through realMs at the score time onMs.
type Stretch = { startMs: number; realMs: number; onMs: number; barEndMs: number; fitted: boolean; chords: Completion[] };

const times = (c: Completion) => [...c.presses.values()].map((p) => p.t);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), k = s.length;
  return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2;
};

export function analyseFollow(
  events: ExpectedEvent[],      // the notes wait mode asked for: the section's
  recording: NoteEvent[],       // in the order received; t = real ms
  speed: number,
  opts: FollowOptions,
  pedalMarks: PedalMark[] = [],
): Alignment {
  // Replay the run: which press completed each chord, which keys were wrong.
  const wait = new WaitMode(events, opts.hands);
  for (const ev of recording) wait.handle(ev);
  const done = wait.completions;
  const pedalReceived = recording.some((e) => e.type === 'pedal');
  if (done.length === 0) return { notes: [], extras: [], pedals: [], pedalExtras: [], pedalReceived };

  const onMsOf = (c: Completion) => wait.chords[c.chord].onMs;
  const at = (st: Stretch, onMs: number) => st.realMs + (onMs - st.onMs) / speed;

  // The clock, chord by chord. Whether a chord is a pause goes by its earliest
  // key: any key on time means it didn't stop. The fit goes by each chord's
  // median key, so a hand that leads doesn't set the clock.
  const stretches: Stretch[] = [];
  const stretchOf = new Map<number, Stretch>();   // chord index → its stretch
  for (const c of done) {
    const { onMs, events: evs } = wait.chords[c.chord];
    const onset = Math.min(...times(c));
    let st = stretches.at(-1);
    if (st && !st.fitted && onMs >= st.barEndMs - 1e-6) {
      st.realMs += median(st.chords.map((k) => median(times(k)) - at(st!, onMsOf(k))));
      st.fitted = true;
    }
    if (!st || onset - at(st, onMs) > (opts.pauseBeats * evs[0].beatMs) / speed) {
      const meter = opts.measures?.[evs[0].measure]?.meter ?? { count: 4, unit: 4 };
      st = { startMs: onset, realMs: onset, onMs, barEndMs: onMs + beatsPerBar(meter) * evs[0].beatMs, fitted: false, chords: [] };
      stretches.push(st);
    }
    st.chords.push(c);
    stretchOf.set(c.chord, st);
  }

  // Real ms → ms on the score axis at this speed. Before the first stretch, its
  // clock extended backwards. During a pause the clock stands at the restart
  // chord: `stopped`.
  const clock = (realMs: number) => {
    const i = Math.max(0, lastAtOrBefore(stretches, realMs, (st) => st.startMs));
    const st = stretches[i], next = stretches[i + 1];
    const ms = st.onMs / speed + (realMs - st.realMs);
    return next && ms >= next.onMs / speed ? { ms: next.onMs / speed, stopped: true } : { ms, stopped: false };
  };
  // A key or pedal held through a pause has no meaningful length.
  const throughPause = (on: number, off: number | undefined) =>
    off !== undefined && stretches.some((st) => st.startMs > on && st.startMs < off);

  const presses = new Map(keyPresses(recording).map((p) => [`${p.pitch}@${p.on}`, p]));
  const notes: PlayedNote[] = done.flatMap((c) => wait.chords[c.chord].events.map((expected): PlayedNote => {
    const press = c.presses.get(expected.pitch)!;
    const key = presses.get(`${expected.pitch}@${press.t}`);
    // The first chord of a stretch is timed only if the stretch was fitted.
    const st = stretchOf.get(c.chord)!;
    const first = st.chords[0] === c;
    const deltaMs = first && !st.fitted ? undefined : press.t - at(st, expected.onMs);
    const beat = expected.beatMs / speed;
    const written = (expected.offMs - expected.onMs) / speed;
    const heldMs = key?.off === undefined ? undefined : key.off - key.on;
    const why = !first ? undefined : st === stretches[0] ? 'first' : 'pause';
    return {
      expected,
      status: 'played',
      onsetMs: clock(press.t).ms,
      deltaMs,
      deltaPct: deltaMs === undefined ? undefined : (deltaMs / beat) * 100,
      heldMs,
      durationPct: heldMs === undefined || written <= 0 || throughPause(press.t, key?.off)
        ? undefined : (heldMs / written) * 100,
      velocity: press.velocity,
      velocityPct: (press.velocity / 127) * 100,
      pedal: key?.pedal ?? false,
      ...(why ? { restart: why } : {}),
    };
  }));

  // Wrong keys, at the chord being asked for. Before the first chord's first
  // key the run hadn't started.
  const start = stretches[0].startMs;
  const extras: Extra[] = wait.wrongs.filter((w) => w.t >= start).map((w) => ({
    pitch: w.pitch, onsetMs: wait.chords[w.chord].onMs / speed, velocity: w.velocity, velocityPct: (w.velocity / 127) * 100,
  }));

  // The pedal against the same clock. A press keeps its real length; one that
  // went down during a pause is untimed.
  const mapped = pedalPresses(recording).map((p) => {
    const { ms, stopped } = clock(p.on);
    return { on: ms, off: p.off === undefined ? undefined : ms + (p.off - p.on), real: p, stopped };
  });
  const firstBeat = notes[0].expected.beatMs / speed;
  const slack = opts.pauseBeats * firstBeat;
  const last = wait.chords[done.at(-1)!.chord];
  const { pedals, pedalExtras, pressOf } = alignPedal(pedalMarks, mapped, speed,
    { ...DEFAULT_ALIGN, maxOffsetBeats: opts.pauseBeats, hands: opts.hands, window: opts.window, untilMs: last.onMs / speed },
    opts.window.startMs / speed - slack, opts.window.endMs / speed + slack);
  for (const p of pedals) {
    const press = pressOf.get(p);
    if (!press) continue;
    if (press.stopped) { p.deltaMs = undefined; p.restart = 'pause'; }
    if (throughPause(press.real.on, press.real.off)) p.durationPct = undefined;
  }

  return { notes, extras, pedals, pedalExtras, pedalReceived };
}

// The bpm, among `bpms`, at which the most notes of the run are within the
// criterion (`within`, × beat): the same playing timed at each. Ties go to the
// one nearest `nearBpm`. Undefined if nothing was timed at any of them.
export type Best = { bpm: number; within: number; total: number };

export function fewestErrors(
  events: ExpectedEvent[], recording: NoteEvent[], opts: FollowOptions,
  within: number, bpms: number[], baseBpm: number, nearBpm: number,
): Best | undefined {
  let best: Best | undefined;
  for (const bpm of bpms) {
    const { notes } = analyseFollow(events, recording, bpm / baseBpm, opts);
    const k = notes.filter((n) => n.deltaPct !== undefined && Math.abs(n.deltaPct) <= within * 100).length;
    if (k === 0) continue;
    if (!best || k > best.within || (k === best.within && Math.abs(bpm - nearBpm) < Math.abs(best.bpm - nearBpm))) {
      best = { bpm, within: k, total: notes.length };
    }
  }
  return best;
}
