import type { ExpectedEvent, Extra, Hands, NoteEvent, PedalMark, PlayedNote } from '../types.ts';
import { DEFAULT_ALIGN, alignPedal, keyPresses, pedalPresses, type Alignment } from './align.ts';
import { WaitMode } from './waitMode.ts';
import { lastAtOrBefore } from '../score/beats.ts';

// After a Follow run: played like wait mode, timed afterwards against a clock at
// the practice speed. The clock starts on the first chord and is never nudged
// towards the player, so drift shows, up to the criterion: a chord all outside
// it, early or late, is timed against the clock that was running and the clock
// restarts from it. A stop is just a late chord. Only the first chord is
// untimed. Pure: no DOM, no clock.

export type FollowOptions = {
  hands: Hands;
  window: { startMs: number; endMs: number };   // the section, as in align; only the pedal needs it
  within: number;                                // × beat: the review's criterion; a chord all outside it restarts the clock
  matchBeats: number;                            // × beat: the review's match window, for the pedal
};

// Where the clock (re)started: real ms, and the chord's score ms.
type Anchor = { realMs: number; onMs: number };

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

  // The clock, chord by chord: each chord's expected real time; the first is
  // an anchor only, a chord all outside the criterion is timed and then an anchor.
  const anchors: Anchor[] = [];
  const restart = new Map<number, 'first' | 'outside'>();   // chord index → why the clock (re)started there
  const expectedAt = new Map<number, number>();             // chord index → real ms
  for (const c of done) {
    const chord = wait.chords[c.chord];
    const times = [...c.presses.values()].map((p) => p.t);
    const a = anchors.at(-1);
    if (a) {
      const at = a.realMs + (chord.onMs - a.onMs) / speed;
      const tol = (opts.within * chord.events[0].beatMs) / speed;
      expectedAt.set(c.chord, at);
      // Every key late, or every key early: one key inside keeps the clock.
      if (Math.min(...times) - at <= tol && Math.max(...times) - at >= -tol) continue;
    }
    anchors.push({ realMs: Math.min(...times), onMs: chord.onMs });
    restart.set(c.chord, a ? 'outside' : 'first');
  }

  // Real ms → ms on the score axis at this speed. Before the first anchor, the
  // first stretch extended backwards. Once it reaches the next restart chord
  // (playing late) it stands there, so the axis stays in order: `lateMs` is
  // where the running clock was.
  const clock = (realMs: number) => {
    const i = Math.max(0, lastAtOrBefore(anchors, realMs, (a) => a.realMs));
    const a = anchors[i], next = anchors[i + 1];
    const ms = a.onMs / speed + (realMs - a.realMs);
    return next && ms >= next.onMs / speed ? { ms: next.onMs / speed, lateMs: ms } : { ms, lateMs: ms };
  };

  const presses = new Map(keyPresses(recording).map((p) => [`${p.pitch}@${p.on}`, p]));
  const notes: PlayedNote[] = done.flatMap((c) => wait.chords[c.chord].events.map((expected): PlayedNote => {
    const press = c.presses.get(expected.pitch)!;
    const key = presses.get(`${expected.pitch}@${press.t}`);
    const at = expectedAt.get(c.chord);
    const deltaMs = at === undefined ? undefined : press.t - at;
    const beat = expected.beatMs / speed;
    const written = (expected.offMs - expected.onMs) / speed;
    const heldMs = key?.off === undefined ? undefined : key.off - key.on;
    const why = restart.get(c.chord);
    return {
      expected,
      status: 'played',
      onsetMs: clock(press.t).ms,
      deltaMs,
      deltaPct: deltaMs === undefined ? undefined : (deltaMs / beat) * 100,
      heldMs,
      durationPct: heldMs === undefined || written <= 0 ? undefined : (heldMs / written) * 100,
      velocity: press.velocity,
      velocityPct: (press.velocity / 127) * 100,
      pedal: key?.pedal ?? false,
      ...(why ? { restart: why } : {}),
    };
  }));

  // Wrong keys, at the chord being asked for. Before the first chord's first
  // key the run hadn't started.
  const start = anchors[0].realMs;
  const extras: Extra[] = wait.wrongs.filter((w) => w.t >= start).map((w) => ({
    pitch: w.pitch, onsetMs: wait.chords[w.chord].onMs / speed, velocity: w.velocity, velocityPct: (w.velocity / 127) * 100,
  }));

  // The pedal against the same clock, matched where it stands, timed where it
  // was running (a pedal pressed while late reads late, as its chord). A press
  // keeps its real length.
  const mapped = pedalPresses(recording).map((p) => {
    const { ms, lateMs } = clock(p.on);
    return { on: ms, off: p.off === undefined ? undefined : ms + (p.off - p.on), lateMs };
  });
  const firstBeat = notes[0].expected.beatMs / speed;
  const slack = opts.matchBeats * firstBeat;
  const last = wait.chords[done.at(-1)!.chord];
  const { pedals, pedalExtras, pressOf } = alignPedal(pedalMarks, mapped, speed,
    { ...DEFAULT_ALIGN, maxOffsetBeats: opts.matchBeats, hands: opts.hands, window: opts.window, untilMs: last.onMs / speed },
    opts.window.startMs / speed - slack, opts.window.endMs / speed + slack);
  for (const p of pedals) {
    const press = pressOf.get(p);
    if (press) p.deltaMs = press.lateMs - p.mark.t / speed;
  }

  return { notes, extras, pedals, pedalExtras, pedalReceived };
}
