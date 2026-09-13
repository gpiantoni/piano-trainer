import type { ExpectedEvent, Hands, NoteEvent } from '../types.ts';

// Wait mode: no clock. The score waits on the current chord (all events sharing
// an onset) until every pitch in it has been pressed, then advances. With one
// hand selected, the other hand's notes are left out entirely.

export type NoteState = 'hit' | 'muted';

export const forHands = (hands: Hands) => (ev: ExpectedEvent) =>
  hands === 'both' || ev.staff === (hands === 'right' ? 1 : 2);

export type Chord = { onMs: number; events: ExpectedEvent[] };

export type Feedback =
  | { kind: 'hit'; event: ExpectedEvent }
  | { kind: 'advance'; chord: number }
  | { kind: 'wrong'; pitch: number; expected: number[] }
  | { kind: 'done' };

export function groupChords(timeline: ExpectedEvent[]): Chord[] {
  const chords: Chord[] = [];
  for (const ev of timeline) {
    const last = chords.at(-1);
    if (last && last.onMs === ev.onMs) last.events.push(ev);
    else chords.push({ onMs: ev.onMs, events: [ev] });
  }
  return chords;
}

export class WaitMode {
  readonly chords: Chord[];
  cursor = 0;
  wrong = 0;
  private pending = new Set<number>();

  private muted: ExpectedEvent[];

  constructor(timeline: ExpectedEvent[], hands: Hands = 'both') {
    const inPlay = forHands(hands);
    this.chords = groupChords(timeline.filter(inPlay));
    this.muted = timeline.filter((ev) => !inPlay(ev));
    this.enter(0);
  }

  get done() { return this.cursor >= this.chords.length; }
  get current(): Chord | undefined { return this.chords[this.cursor]; }

  // Pitches of the current chord not yet played.
  get expected(): number[] { return [...this.pending].sort((a, b) => a - b); }

  // Visual state of every notehead id; the view re-applies this after a re-layout.
  // Notes still to play have no state: they stay black.
  noteStates(): Map<string, NoteState> {
    const states = new Map<string, NoteState>();
    const mark = (ev: ExpectedEvent, s: NoteState) => {
      for (const id of [ev.id, ...ev.tiedIds]) states.set(id, s);
    };
    for (const ev of this.muted) mark(ev, 'muted');
    for (let i = 0; i < Math.min(this.cursor, this.chords.length); i++) {
      for (const ev of this.chords[i].events) mark(ev, 'hit');
    }
    for (const ev of this.current?.events ?? []) {
      if (!this.pending.has(ev.pitch)) mark(ev, 'hit');
    }
    return states;
  }

  handle(ev: NoteEvent): Feedback[] {
    if (ev.type !== 'on' || this.done) return [];
    const chord = this.current!;

    if (this.pending.delete(ev.pitch)) {
      // A unison (both hands on one pitch) is satisfied by a single press.
      const out: Feedback[] = chord.events
        .filter((e) => e.pitch === ev.pitch)
        .map((event) => ({ kind: 'hit', event }));
      if (this.pending.size === 0) {
        this.enter(this.cursor + 1);
        out.push(this.done ? { kind: 'done' } : { kind: 'advance', chord: this.cursor });
      }
      return out;
    }

    // Re-striking a note of this chord that is already green is not a mistake.
    if (chord.events.some((e) => e.pitch === ev.pitch)) return [];

    this.wrong++;
    return [{ kind: 'wrong', pitch: ev.pitch, expected: this.expected }];
  }

  restart() {
    this.wrong = 0;
    this.enter(0);
  }

  private enter(index: number) {
    this.cursor = index;
    this.pending = new Set(this.chords[index]?.events.map((e) => e.pitch) ?? []);
  }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
