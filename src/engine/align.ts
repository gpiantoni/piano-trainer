import type {
  ExpectedEvent, Extra, Hands, NoteEvent, PedalExtra, PedalMark, PlayedNote, PlayedPedal,
} from '../types.ts';

// After a tempo run: pair every recorded key press with the score note it was
// meant for, then measure timing, duration and velocity. Pure: no DOM, no clock.
//
// Pitch is exact, and within one pitch the order of notes is kept, so each pitch
// is aligned separately with a small edit-distance programme. Looking at the
// whole run at once means a very late key still pairs with the right note.

export type AlignOptions = {
  maxOffsetBeats: number;       // beyond this a key is not that note: missed + extra
  hands: Hands;                 // notes of the other hand are aligned but not reported
  untilMs: number;              // run stopped here (real ms from t0): later notes are not reported
  // Only notes starting in [startMs, endMs) (score ms at 1.0×) are reported: a
  // section of bars. Alignment still uses the whole timeline, so a key played
  // for a note just outside the section pairs with that note, not with one inside.
  window: { startMs: number; endMs: number };
  // This run's own typical timing offset (re-center): shifts where the match
  // window is centred, so a consistent lag or rush doesn't push notes outside
  // it. Reported deltaMs/deltaPct stay raw, unshifted.
  biasMs: number;
};

export const DEFAULT_ALIGN: AlignOptions = {
  maxOffsetBeats: 1, hands: 'both', untilMs: Infinity,
  window: { startMs: -Infinity, endMs: Infinity }, biasMs: 0,
};

export type Alignment = {
  notes: PlayedNote[];
  extras: Extra[];
  pedals: PlayedPedal[];
  pedalExtras: PedalExtra[];
  pedalReceived: boolean;       // any pedal message at all during the run
};

type Press = { pitch: number; on: number; off?: number; velocity: number; pedal: boolean };

// The pedal going down or up. A pedal with a sensor sends a stream of values:
// only the changes count, and it starts up.
export function pedalChanges(recording: NoteEvent[]): { down: boolean; t: number }[] {
  const out: { down: boolean; t: number }[] = [];
  let down = false;
  for (const ev of [...recording].sort((a, b) => a.t - b.t)) {
    if (ev.type !== 'pedal' || ev.down === down) continue;
    down = ev.down;
    out.push({ down, t: ev.t });
  }
  return out;
}

// The pedal's presses, like a key's: down, and up if it came.
export function pedalPresses(recording: NoteEvent[]): { on: number; off?: number }[] {
  const out: { on: number; off?: number }[] = [];
  for (const { down, t } of pedalChanges(recording)) {
    if (down) out.push({ on: t });
    else out.at(-1)!.off = t;
  }
  return out;
}

// Key presses with their releases. A new press of a key still down (some pianos
// never send the release in between) ends the previous one.
export function keyPresses(recording: NoteEvent[]): Press[] {
  const events = [...recording].sort((a, b) => a.t - b.t);
  const presses: Press[] = [];
  const open = new Map<number, Press>();
  for (const ev of events) {
    if (ev.type === 'pedal') continue;
    const held = open.get(ev.pitch);
    if (held) { held.off = ev.t; open.delete(ev.pitch); }
    if (ev.type === 'on') {
      const press: Press = { pitch: ev.pitch, on: ev.t, velocity: ev.velocity, pedal: false };
      presses.push(press);
      open.set(ev.pitch, press);
    }
  }
  const pedal = pedalPresses(events);
  for (const p of presses) {
    const end = p.off ?? p.on;
    p.pedal = pedal.some(({ on, off = Infinity }) => on <= end && off >= p.on);
  }
  return presses;
}

// Minimum-cost monotone pairing of sorted expected times with sorted press
// times. Returns, for each expected index, the matched press index or -1.
function alignTimes(
  expected: { t: number; beat: number }[], presses: number[], maxOffsetBeats: number, biasMs: number,
): number[] {
  const n = expected.length, m = presses.length;
  const skip = maxOffsetBeats;   // a match inside the window always beats miss + extra
  const cost = new Float64Array((n + 1) * (m + 1));
  const from = new Uint8Array((n + 1) * (m + 1));   // 0 match, 1 skip expected, 2 skip press
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) { cost[at(i, 0)] = i * skip; from[at(i, 0)] = 1; }
  for (let j = 1; j <= m; j++) { cost[at(0, j)] = j * skip; from[at(0, j)] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = cost[at(i - 1, j)] + skip, how = 1;
      if (cost[at(i, j - 1)] + skip < best) { best = cost[at(i, j - 1)] + skip; how = 2; }
      const e = expected[i - 1];
      // Window is centred on the re-centered expectation, not the raw one.
      const d = Math.abs(presses[j - 1] - e.t - biasMs) / e.beat;
      if (d <= maxOffsetBeats && cost[at(i - 1, j - 1)] + d <= best) { best = cost[at(i - 1, j - 1)] + d; how = 0; }
      cost[at(i, j)] = best;
      from[at(i, j)] = how;
    }
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const how = from[at(i, j)];
    if (how === 0) { match[i - 1] = j - 1; i--; j--; }
    else if (how === 1) i--;
    else j--;
  }
  return match;
}

export function align(
  events: ExpectedEvent[],
  recording: NoteEvent[],
  speed: number,
  options: Partial<AlignOptions> = {},
  pedalMarks: PedalMark[] = [],
): Alignment {
  const opts = { ...DEFAULT_ALIGN, ...options };
  const presses = keyPresses(recording);
  const used = new Set<Press>();
  const played = new Map<ExpectedEvent, Press>();

  const pitches = new Set([...events.map((e) => e.pitch), ...presses.map((p) => p.pitch)]);
  for (const pitch of pitches) {
    const exp = events.filter((e) => e.pitch === pitch).sort((a, b) => a.onMs - b.onMs);
    const prs = presses.filter((p) => p.pitch === pitch);   // already in time order
    if (exp.length === 0 || prs.length === 0) continue;
    const match = alignTimes(
      exp.map((e) => ({ t: e.onMs / speed, beat: e.beatMs / speed })),
      prs.map((p) => p.on),
      opts.maxOffsetBeats,
      opts.biasMs,
    );
    match.forEach((j, i) => {
      if (j < 0) return;
      played.set(exp[i], prs[j]);
      used.add(prs[j]);
    });
  }

  const inHand = (e: ExpectedEvent) => opts.hands === 'both' || e.staff === (opts.hands === 'right' ? 1 : 2);
  const reached = (e: ExpectedEvent) => e.onMs / speed <= opts.untilMs || played.has(e);
  const { startMs, endMs } = opts.window;
  const inWindow = (e: ExpectedEvent) => e.onMs >= startMs - 1e-6 && e.onMs < endMs - 1e-6;
  const notes: PlayedNote[] = events.filter((e) => inHand(e) && inWindow(e) && reached(e)).map((expected) => {
    const press = played.get(expected);
    if (!press) return { expected, status: 'missed' };
    const at = expected.onMs / speed;
    const beat = expected.beatMs / speed;
    const written = (expected.offMs - expected.onMs) / speed;
    const deltaMs = press.on - at;
    const heldMs = press.off === undefined ? undefined : press.off - press.on;
    return {
      expected,
      status: 'played',
      onsetMs: press.on,
      deltaMs,
      deltaPct: (deltaMs / beat) * 100,
      heldMs,
      durationPct: heldMs === undefined || written <= 0 ? undefined : (heldMs / written) * 100,
      velocity: press.velocity,
      velocityPct: (press.velocity / 127) * 100,
      pedal: press.pedal,
    };
  });

  // Unmatched keys count as extras only around the section: not during the
  // count-in, nor after its end. One match window of slack on each side.
  const slack = (opts.maxOffsetBeats * (notes[0]?.expected.beatMs ?? 0)) / speed;
  const from = startMs / speed + opts.biasMs - slack, to = endMs / speed + opts.biasMs + slack;
  const extras: Extra[] = presses
    .filter((p) => !used.has(p) && p.on >= from && p.on < to)
    .map((p) => ({ pitch: p.pitch, onsetMs: p.on, velocity: p.velocity }));

  // A missed note with an unmatched key a semitone or two away, in its window:
  // most likely that key was meant for it.
  for (const note of notes) {
    if (note.status !== 'missed') continue;
    const at = note.expected.onMs / speed + opts.biasMs, window = (opts.maxOffsetBeats * note.expected.beatMs) / speed;
    let best: Extra | undefined;
    for (const x of extras) {
      if (x.wrongFor || Math.abs(x.pitch - note.expected.pitch) > 2 || Math.abs(x.onsetMs - at) > window) continue;
      if (!best || Math.abs(x.onsetMs - at) < Math.abs(best.onsetMs - at)) best = x;
    }
    if (best) {
      best.wrongFor = note.expected.id;
      note.wrongPitch = best.pitch;
    }
  }

  return { notes, extras, ...alignPedal(pedalMarks, recording, speed, opts, from, to) };
}

// Pedal signs, like the notes of one pitch: each Ped. with the pedal going
// down, in order, within the same match window; the * that ends its span with
// the pedal's next lift, for how long it was held. Not tied to a hand.
function alignPedal(
  marks: PedalMark[], recording: NoteEvent[], speed: number, opts: AlignOptions, from: number, to: number,
): Pick<Alignment, 'pedals' | 'pedalExtras' | 'pedalReceived'> {
  const presses = pedalPresses(recording);
  const downs = marks.filter((m) => m.down);
  const played = new Map<PedalMark, { on: number; off?: number }>();
  const used = new Set<{ on: number; off?: number }>();
  if (downs.length && presses.length) {
    const match = alignTimes(
      downs.map((m) => ({ t: m.t / speed, beat: m.beatMs / speed })), presses.map((p) => p.on), opts.maxOffsetBeats, opts.biasMs,
    );
    match.forEach((j, i) => {
      if (j < 0) return;
      played.set(downs[i], presses[j]);
      used.add(presses[j]);
    });
  }

  // In the section: a Ped. from its first downbeat until its last barline.
  const { startMs, endMs } = opts.window;
  const pedals: PlayedPedal[] = downs
    .filter((m) => m.t >= startMs - 1e-6 && m.t < endMs - 1e-6 && (m.t / speed <= opts.untilMs || played.has(m)))
    .map((mark) => {
      // Marks are sorted with an up before a down at the same time: the first
      // up after this down, even a change sign sharing its time with the next Ped.
      const end = marks.find((m) => !m.down && m.t > mark.t);
      const press = played.get(mark);
      if (!press) return { mark, end };
      const heldMs = press.off === undefined ? undefined : press.off - press.on;
      const written = end && (end.t - mark.t) / speed;
      return {
        mark, end, atMs: press.on, deltaMs: press.on - mark.t / speed, heldMs,
        durationPct: heldMs === undefined || !written ? undefined : (heldMs / written) * 100,
      };
    });
  const pedalExtras = presses
    .filter((p) => !used.has(p) && p.on >= from && p.on < to)
    .map((p) => ({ atMs: p.on, heldMs: p.off === undefined ? undefined : p.off - p.on }));
  return { pedals, pedalExtras, pedalReceived: recording.some((e) => e.type === 'pedal') };
}

// Below this many timed notes, a run's typical offset is too noisy to zero against.
export const OFFSET_MIN_NOTES = 50;

// This run's own typical timing offset: the median deltaMs of the notes an
// alignment centred on the score found. Call it with the widest match window,
// so the offset belongs to the run, not to the window chosen for review.
// ms is undefined below OFFSET_MIN_NOTES timed notes.
export function runOffset(a: Alignment): { ms: number | undefined; notes: number } {
  const deltas = a.notes.flatMap((n) => (n.deltaMs === undefined ? [] : [n.deltaMs])).sort((x, y) => x - y);
  const k = deltas.length;
  if (k < OFFSET_MIN_NOTES) return { ms: undefined, notes: k };
  return { ms: k % 2 ? deltas[(k - 1) / 2] : (deltas[k / 2 - 1] + deltas[k / 2]) / 2, notes: k };
}
