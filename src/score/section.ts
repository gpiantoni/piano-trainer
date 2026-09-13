import { beatsPerBar } from './beats.ts';
import type { ScoreTiming } from './timeline.ts';

// Practising only some bars. Pure: no DOM, tested in Node.
//
// Score times stay absolute (ms at 1.0× from the start of the piece), so the
// cursor, note positions and review colours need no offset. A run just starts
// and ends somewhere else: this window says where, and what the count-in is.

export type Section = { from: number; to: number };   // measure indices, inclusive, performance order

export type Click = { t: number; accent: boolean };

export type PlayWindow = {
  startMs: number;     // score time of the first downbeat played
  endMs: number;       // score time where the section ends
  countIn: Click[];    // before startMs
  section?: Section;   // undefined: the whole piece
};

const EPS = 1e-6;

export function playWindow(timing: ScoreTiming, section?: Section): PlayWindow {
  const { measures } = timing;
  if (!section || measures.length === 0) {
    return { startMs: Math.min(0, measures[0]?.startMs ?? 0), endMs: timing.endMs, countIn: timing.countIn };
  }
  const first = measures[section.from], last = measures[section.to];
  // From the first bar, the piece's own count-in already handles a pickup.
  if (section.from === 0) {
    return { startMs: first.startMs, endMs: last.endMs, countIn: timing.countIn, section };
  }
  // Otherwise one full bar of the section's meter, at the tempo where it starts.
  const perBar = beatsPerBar(first.meter);
  const beats = timing.beats.filter((b) => b.measure === section.from);
  const beatMs = beats.length > 1 ? beats[1].t - beats[0].t : (first.endMs - first.startMs) / perBar;
  const countIn = Array.from({ length: perBar }, (_, i) => ({
    t: first.startMs - (perBar - i) * beatMs,
    accent: i === 0,
  }));
  return { startMs: first.startMs, endMs: last.endMs, countIn, section };
}

// Does a note starting at `onMs` belong to the window?
export const inWindow = (w: Pick<PlayWindow, 'startMs' | 'endMs'>, onMs: number) =>
  onMs >= w.startMs - EPS && onMs < w.endMs - EPS;

// Two taps, in either order.
export const sectionFrom = (a: number, b: number): Section => ({ from: Math.min(a, b), to: Math.max(a, b) });

export function sectionLabel(timing: ScoreTiming, s: Section): string {
  const a = timing.measures[s.from]?.n ?? String(s.from + 1);
  const b = timing.measures[s.to]?.n ?? String(s.to + 1);
  return s.from === s.to ? `Bar ${a}` : `Bars ${a}–${b}`;
}

// Stored as "from-to". Anything that no longer fits the score is dropped.
export const formatSection = (s: Section) => `${s.from}-${s.to}`;

export function parseSection(text: string | null, measureCount: number): Section | undefined {
  const m = text?.match(/^(\d+)-(\d+)$/);
  if (!m) return undefined;
  const from = Number(m[1]), to = Number(m[2]);
  return from <= to && to < measureCount ? { from, to } : undefined;
}
