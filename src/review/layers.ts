import type { Alignment, TimingReference } from '../engine/align.ts';
import type { PlayedNote } from '../types.ts';
import {
  DURATION_RAMP, NOTES, NOT_MEASURED, TIMING_LOG_KNEE, TIMING_RAMP, VELOCITY_RAMP,
} from './palettes.ts';

// PlayedNote -> colour, legend and one-line summary, per review layer.
// Measurements, not judgements: no layer but "notes" has a good colour.

export type Layer = 'notes' | 'timing' | 'duration' | 'velocity';

export type ReviewSettings = {
  layer: Layer;
  maxOffsetBeats: number;
  reference: TimingReference;
  timingRange: number;     // ± %
  timingLog: boolean;
  durationMax: number;     // %
  velocityFit: boolean;    // fit the ramp to this run instead of 0–100
  recenter: boolean;       // shift timing's zero to this run's own mean offset
};

export const DEFAULT_SETTINGS: ReviewSettings = {
  layer: 'notes', maxOffsetBeats: 1, reference: 'beat',
  timingRange: 25, timingLog: false, durationMax: 150, velocityFit: false, recenter: false,
};

// Below this many timed notes, a mean offset is too noisy to zero against.
export const RECENTER_MIN_NOTES = 50;

export type Legend = { gradient: string; ticks: { at: number; label: string }[] };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: string, b: string, bShare: number) =>
  bShare <= 0 ? a : bShare >= 1 ? b : `color-mix(in oklab, ${b} ${(bShare * 100).toFixed(1)}%, ${a})`;

function ramp(stops: string[], x: number): string {
  const pos = clamp01(x) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  return mix(stops[i], stops[i + 1], pos - i);
}

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};

// Timing: signed position in [-1, 1].
function timingScale(pct: number, s: ReviewSettings): number {
  const k = TIMING_LOG_KNEE;
  const v = s.timingLog
    ? (Math.sign(pct) * Math.log1p(Math.abs(pct) / k)) / Math.log1p(s.timingRange / k)
    : pct / s.timingRange;
  return Math.max(-1, Math.min(1, v));
}

export type Context = {
  velocityLo: number;
  velocityHi: number;
  beatMs?: number;          // one beat in real ms at the run's speed, at the start
  timingBiasPct: number;    // subtracted from deltaPct when recenter is on and there's enough data; 0 otherwise
  timingBiasMs: number;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// This run's own mean timing offset, to zero against instead of the score.
// Needs RECENTER_MIN_NOTES played notes or it's too noisy to trust.
function timingBias(a: Alignment, s: ReviewSettings): { timingBiasPct: number; timingBiasMs: number } {
  if (!s.recenter) return { timingBiasPct: 0, timingBiasMs: 0 };
  const played = a.notes.filter((n) => n.status === 'played' && n.deltaPct !== undefined);
  if (played.length < RECENTER_MIN_NOTES) return { timingBiasPct: 0, timingBiasMs: 0 };
  return { timingBiasPct: mean(played.map((n) => n.deltaPct!)), timingBiasMs: mean(played.map((n) => n.deltaMs!)) };
}

export function context(a: Alignment, s: ReviewSettings, speed: number): Context {
  const first = a.notes[0]?.expected.beatMs;
  const beatMs = first ? first / speed : undefined;
  const v = a.notes.flatMap((n) => (n.velocityPct === undefined ? [] : [n.velocityPct]));
  let velocityLo = 0, velocityHi = 100;
  if (s.velocityFit && v.length >= 2) {
    const lo = quantile(v, 0.05), hi = quantile(v, 0.95);
    if (hi - lo < 2) { velocityLo = Math.max(0, lo - 5); velocityHi = Math.min(100, hi + 5); }
    else { velocityLo = lo; velocityHi = hi; }
  }
  return { velocityLo, velocityHi, beatMs, ...timingBias(a, s) };
}

// Where a played note sits on the current layer's [0, 1] ramp, or undefined
// if this layer doesn't measure it (e.g. a grace note has no durationPct).
// Shared by colorFor (the notehead colour) and distribution (the strip plot),
// so the dots always line up with the ramp under them.
function position(n: PlayedNote, s: ReviewSettings, c: Context): number | undefined {
  switch (s.layer) {
    case 'notes':
      return undefined;
    case 'timing':
      return (timingScale(n.deltaPct! - c.timingBiasPct, s) + 1) / 2;
    case 'duration':
      return n.durationPct === undefined ? undefined : n.durationPct / s.durationMax;
    case 'velocity':
      return (n.velocityPct! - c.velocityLo) / (c.velocityHi - c.velocityLo);
  }
}

export function colorFor(n: PlayedNote, s: ReviewSettings, c: Context): string {
  if (s.layer === 'notes') return n.status === 'played' ? NOTES.played : NOTES.missed;
  if (n.status !== 'played') return NOT_MEASURED;
  const pos = position(n, s, c);
  const ramps = { timing: TIMING_RAMP, duration: DURATION_RAMP, velocity: VELOCITY_RAMP };
  return pos === undefined ? NOT_MEASURED : ramp(ramps[s.layer], pos);
}

// Every played note, positioned on the same [0, 1] axis as the layer's ramp:
// a strip plot to draw directly over it. Empty for the "notes" layer, which
// has no ramp.
export function distribution(a: Alignment, s: ReviewSettings, c: Context): number[] {
  if (s.layer === 'notes') return [];
  return a.notes
    .filter((n) => n.status === 'played')
    .flatMap((n) => { const pos = position(n, s, c); return pos === undefined ? [] : [clamp01(pos)]; });
}

const signed = (x: number, digits = 0) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(digits)}`;

export function legend(s: ReviewSettings, c: Context): Legend | undefined {
  switch (s.layer) {
    case 'notes':
      return undefined;
    case 'timing': {
      const r = s.timingRange;
      const values = s.timingLog ? [-r, -r / 5, 0, r / 5, r] : [-r, -r / 2, 0, r / 2, r];
      return {
        gradient: `linear-gradient(in oklab to right, ${TIMING_RAMP.join(', ')})`,
        // In % of a beat, also say how many ms that is at this speed.
        ticks: values.map((v) => {
          const ms = s.reference === 'beat' && c.beatMs ? `\n${Math.round((Math.abs(v) / 100) * c.beatMs)} ms` : '';
          return { at: (timingScale(v, s) + 1) / 2, label: v === 0 ? 'on time' : `${signed(v, Math.abs(v) < 10 ? 1 : 0)} %${ms}` };
        }),
      };
    }
    case 'duration': {
      const step = s.durationMax > 150 ? 50 : 25;
      const ticks = [];
      for (let v = 0; v <= s.durationMax; v += step) ticks.push({ at: v / s.durationMax, label: `${v} %` });
      return { gradient: `linear-gradient(in oklab to right, ${DURATION_RAMP.join(', ')})`, ticks };
    }
    case 'velocity': {
      const { velocityLo: lo, velocityHi: hi } = c;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, label: `${Math.round(lo + (hi - lo) * at)} %` }));
      return { gradient: `linear-gradient(in oklab to right, ${VELOCITY_RAMP.join(', ')})`, ticks };
    }
  }
}

const fmtMedian = (xs: number[], f: (x: number) => string) => (xs.length ? f(quantile(xs, 0.5)) : '—');

function byHand(notes: PlayedNote[], value: (n: PlayedNote) => number | undefined, f: (x: number) => string): string {
  const all = notes.flatMap((n) => { const v = value(n); return v === undefined ? [] : [v]; });
  const parts = [`median ${fmtMedian(all, f)}`];
  const rh = notes.filter((n) => n.expected.staff === 1).flatMap((n) => { const v = value(n); return v === undefined ? [] : [v]; });
  const lh = notes.filter((n) => n.expected.staff === 2).flatMap((n) => { const v = value(n); return v === undefined ? [] : [v]; });
  if (rh.length && lh.length) parts.push(`RH ${fmtMedian(rh, f)}`, `LH ${fmtMedian(lh, f)}`);
  return parts.join(' · ');
}

export function summary(a: Alignment, s: ReviewSettings, c: Context): string {
  const played = a.notes.filter((n) => n.status === 'played');
  switch (s.layer) {
    case 'notes': {
      const missed = a.notes.length - played.length;
      const wrong = a.notes.filter((n) => n.wrongPitch !== undefined).length;
      const extras = a.extras.filter((x) => !x.wrongFor).length;
      return `${played.length} / ${a.notes.length} played · ${missed} missed${wrong ? ` (${wrong} wrong key)` : ''} · ${extras} extra`;
    }
    case 'timing': {
      if (!played.length) return 'nothing played';
      const fmt = (ns: PlayedNote[]) =>
        `${signed(quantile(ns.map((n) => n.deltaPct! - c.timingBiasPct), 0.5))} % `
        + `(${signed(quantile(ns.map((n) => n.deltaMs! - c.timingBiasMs), 0.5))} ms)`;
      const rh = played.filter((n) => n.expected.staff === 1);
      const lh = played.filter((n) => n.expected.staff === 2);
      const parts = [`median ${fmt(played)}`];
      if (rh.length && lh.length) parts.push(`RH ${fmt(rh)}`, `LH ${fmt(lh)}`);
      if (c.beatMs) parts.push(`1 beat = ${Math.round(c.beatMs)} ms`);
      if (s.recenter) {
        parts.push(c.timingBiasPct !== 0 || c.timingBiasMs !== 0
          ? `recentered, ${signed(c.timingBiasPct, 1)} % (${signed(Math.round(c.timingBiasMs))} ms) removed`
          : `recenter needs ≥ ${RECENTER_MIN_NOTES} notes (${played.length} played)`);
      }
      return parts.join(' · ');
    }
    case 'duration':
      return byHand(played, (n) => n.durationPct, (x) => `${x.toFixed(0)} %`);
    case 'velocity':
      return byHand(played, (n) => n.velocityPct, (x) => `${x.toFixed(0)} %`);
  }
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

// Everything about one note at once, for the tap popover.
export function describe(n: PlayedNote, reference: TimingReference, bias?: { pct: number; ms: number }): string {
  const name = pitchName(n.expected.pitch);
  if (n.status !== 'played') {
    return n.wrongPitch !== undefined ? `${name} · missed (played ${pitchName(n.wrongPitch)})` : `${name} · missed`;
  }
  const deltaMs = n.deltaMs! - (bias?.ms ?? 0), deltaPct = n.deltaPct! - (bias?.pct ?? 0);
  const parts = [
    name,
    `${signed(deltaMs)} ms (${signed(deltaPct)} % ${reference === 'beat' ? 'of beat' : 'of note'})`,
    n.heldMs === undefined ? 'still held' : `held ${n.heldMs.toFixed(0)} ms (${n.durationPct?.toFixed(0) ?? '—'} %)`,
    `vel ${n.velocity} (${n.velocityPct!.toFixed(0)} %)`,
  ];
  if (n.pedal) parts.push('pedal');
  return parts.join(' · ');
}
