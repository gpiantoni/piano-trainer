import { OFFSET_MIN_NOTES, type Alignment } from '../engine/align.ts';
import type { PlayedNote, PlayedPedal } from '../types.ts';
import { NOT_MEASURED, RAMP, TIMING_CRITERIA, TIMING_LOG_KNEE } from './palettes.ts';

// PlayedNote -> colour, legend and one-line summary, per review layer.
// Measurements on one shared ramp; the only line drawn is the timing criterion
// the user picked.

export type Layer = 'notes' | 'duration' | 'velocity' | 'pedal';

export type ReviewSettings = {
  layer: Layer;
  within: number;          // timing criterion, one of TIMING_CRITERIA's; sets the match window too
  timingLog: boolean;
  durationMax: number;     // %
  velocityFit: boolean;    // fit the ramp to this run instead of 0–100
  recenter: boolean;       // centre the match window and timing's zero on this run's own offset
};

export const DEFAULT_SETTINGS: ReviewSettings = {
  layer: 'notes', within: 0.1,
  timingLog: false, durationMax: 150, velocityFit: false, recenter: false,
};

// marks: positions on the ramp to draw a line at (the timing criterion's edges).
export type Legend = { gradient: string; ticks: { at: number; label: string }[]; marks?: number[] };

const GRADIENT = `linear-gradient(in oklab to right, ${RAMP.join(', ')})`;

// The match window paired with the criterion: also the timing ramp's ± range.
export const windowOf = (s: ReviewSettings) =>
  (TIMING_CRITERIA.find((t) => t.within === s.within) ?? TIMING_CRITERIA[0]).window;

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

// Timing: signed position in [-1, 1]. Full colour at the match window's edge,
// so every played note falls on the ramp.
function timingScale(pct: number, s: ReviewSettings): number {
  const k = TIMING_LOG_KNEE, range = windowOf(s) * 100;
  const v = s.timingLog
    ? (Math.sign(pct) * Math.log1p(Math.abs(pct) / k)) / Math.log1p(range / k)
    : pct / range;
  return Math.max(-1, Math.min(1, v));
}

// This run's own typical timing offset (see runOffset), measured before the
// match window: ms is undefined below OFFSET_MIN_NOTES timed notes.
export type Offset = { ms: number | undefined; notes: number };

export type Context = {
  velocityLo: number;
  velocityHi: number;
  speed: number;
  beatMs?: number;          // one beat in real ms at the run's speed, at the start
  offset: Offset;
  biasMs: number;           // offset.ms when re-center is on and there's enough data; 0 otherwise
};

export function context(a: Alignment, s: ReviewSettings, speed: number, offset: Offset): Context {
  const first = a.notes[0]?.expected.beatMs;
  const beatMs = first ? first / speed : undefined;
  const v = a.notes.flatMap((n) => (n.velocityPct === undefined ? [] : [n.velocityPct]));
  let velocityLo = 0, velocityHi = 100;
  if (s.velocityFit && v.length >= 2) {
    const lo = quantile(v, 0.05), hi = quantile(v, 0.95);
    if (hi - lo < 2) { velocityLo = Math.max(0, lo - 5); velocityHi = Math.min(100, hi + 5); }
    else { velocityLo = lo; velocityHi = hi; }
  }
  const biasMs = s.recenter ? offset.ms ?? 0 : 0;
  return { velocityLo, velocityHi, speed, beatMs, offset, biasMs };
}

// A timing offset from the (re-centered) zero: ms, and % of its beat.
function timingOf(deltaMs: number, beatMs: number, c: Context): { ms: number; pct: number } {
  const ms = deltaMs - c.biasMs;
  return { ms, pct: (ms / (beatMs / c.speed)) * 100 };
}
const timing = (n: PlayedNote, c: Context) => timingOf(n.deltaMs!, n.expected.beatMs, c);
const pedalTiming = (p: PlayedPedal, c: Context) => timingOf(p.deltaMs!, p.mark.beatMs, c);

// Where a played note sits on the current layer's [0, 1] ramp, or undefined
// if this layer doesn't measure it (e.g. a grace note has no durationPct).
// Shared by colorFor (the notehead colour) and distribution (the strip plot),
// so the dots always line up with the ramp under them.
function position(n: PlayedNote, s: ReviewSettings, c: Context): number | undefined {
  switch (s.layer) {
    case 'pedal':
      return undefined;
    case 'notes':
      return (timingScale(timing(n, c).pct, s) + 1) / 2;
    case 'duration':
      return n.durationPct === undefined ? undefined : n.durationPct / s.durationMax;
    case 'velocity':
      return (n.velocityPct! - c.velocityLo) / (c.velocityHi - c.velocityLo);
  }
}

export function colorFor(n: PlayedNote, s: ReviewSettings, c: Context): string {
  if (n.status !== 'played') return NOT_MEASURED;
  const pos = position(n, s, c);
  return pos === undefined ? NOT_MEASURED : ramp(RAMP, pos);
}

// A played note further from the (re-centered) score time than the criterion.
export function outside(n: PlayedNote, s: ReviewSettings, c: Context): 'early' | 'late' | undefined {
  if (n.status !== 'played') return undefined;
  const { pct } = timing(n, c);
  if (Math.abs(pct) <= s.within * 100) return undefined;
  return pct < 0 ? 'early' : 'late';
}

// A pedalled span, like a note: the Ped. sign on the timing ramp (when the
// pedal went down), the * on the duration ramp (how long it stayed down).
// Grey where there's no measurement.
const pedalTimingPos = (p: PlayedPedal, s: ReviewSettings, c: Context) => (timingScale(pedalTiming(p, c).pct, s) + 1) / 2;
const pedalHeldPos = (p: PlayedPedal, s: ReviewSettings) => p.durationPct! / s.durationMax;
export const pedalColor = (p: PlayedPedal, sign: 'down' | 'up', s: ReviewSettings, c: Context) => {
  if (sign === 'down') return p.deltaMs === undefined ? NOT_MEASURED : ramp(RAMP, pedalTimingPos(p, s, c));
  return p.durationPct === undefined ? NOT_MEASURED : ramp(RAMP, pedalHeldPos(p, s));
};

// Every played note, positioned on the same [0, 1] axis as the layer's ramp:
// a strip plot to draw directly over it, one row per hand where the layer
// splits them.
export type DistRow = { label?: string; xs: number[] };

function distribution(a: Alignment, s: ReviewSettings, c: Context): DistRow[] {
  const xs = (notes: PlayedNote[]) => notes
    .filter((n) => n.status === 'played')
    .flatMap((n) => { const pos = position(n, s, c); return pos === undefined ? [] : [clamp01(pos)]; });
  const rh = a.notes.filter((n) => n.expected.staff === 1), lh = a.notes.filter((n) => n.expected.staff === 2);
  // Velocity: the two hands often aim for different dynamics.
  if (s.layer === 'velocity' && xs(rh).length && xs(lh).length) return [{ label: 'RH', xs: xs(rh) }, { label: 'LH', xs: xs(lh) }];
  return [{ xs: xs(a.notes) }];
}

const signed = (x: number, digits = 0) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(digits)}`;

// The layer's ramps, each with its strip plot above it: two for "pedal" (down
// timing, held duration), one for the others.
export type Panel = { legend: Legend; rows: DistRow[] };

export function panels(a: Alignment, s: ReviewSettings, c: Context): Panel[] {
  switch (s.layer) {
    case 'pedal': {
      const pos = (f: (p: PlayedPedal) => number | undefined) =>
        a.pedals.flatMap((p) => { const x = f(p); return x === undefined ? [] : [clamp01(x)]; });
      return [
        { legend: legend('timing', s, c), rows: [{ label: 'Ped', xs: pos((p) => (p.deltaMs === undefined ? undefined : pedalTimingPos(p, s, c))) }] },
        { legend: legend('duration', s, c), rows: [{ label: 'held', xs: pos((p) => (p.durationPct === undefined ? undefined : pedalHeldPos(p, s))) }] },
      ];
    }
    case 'notes':
      return [{ legend: legend('timing', s, c), rows: distribution(a, s, c) }];
    default:
      return [{ legend: legend(s.layer, s, c), rows: distribution(a, s, c) }];
  }
}

function legend(layer: 'timing' | 'duration' | 'velocity', s: ReviewSettings, c: Context): Legend {
  switch (layer) {
    case 'timing': {
      const r = windowOf(s) * 100, w = s.within * 100;
      const values = [-r, -w, 0, w, r];
      return {
        gradient: GRADIENT,
        marks: [-w, w].map((v) => (timingScale(v, s) + 1) / 2),
        // In % of a beat, also say how many ms that is at this speed.
        ticks: values.map((v) => {
          const ms = c.beatMs ? `\n${Math.round((Math.abs(v) / 100) * c.beatMs)} ms` : '';
          return { at: (timingScale(v, s) + 1) / 2, label: v === 0 ? 'on time' : `${signed(v, Math.abs(v) < 10 ? 1 : 0)} %${ms}` };
        }),
      };
    }
    case 'duration': {
      const step = s.durationMax > 150 ? 50 : 25;
      const ticks = [];
      for (let v = 0; v <= s.durationMax; v += step) ticks.push({ at: v / s.durationMax, label: `${v} %` });
      return { gradient: GRADIENT, ticks };
    }
    case 'velocity': {
      const { velocityLo: lo, velocityHi: hi } = c;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, label: `${Math.round(lo + (hi - lo) * at)} %` }));
      return { gradient: GRADIENT, ticks };
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

// The run's own offset, and whether the window and timing are centred on it.
function offsetPart(s: ReviewSettings, c: Context): string[] {
  const { ms, notes } = c.offset;
  if (ms === undefined) return s.recenter ? [`re-center needs ≥ ${OFFSET_MIN_NOTES} timed notes (${notes})`] : [];
  const pct = c.beatMs ? `${signed((ms / c.beatMs) * 100, 1)} % ` : '';
  return [`${s.recenter ? 're-centered on' : 'run offset'} ${pct}(${signed(Math.round(ms))} ms)`];
}

const withinLabel = (s: ReviewSettings) => `within ±${Math.round(s.within * 100)} %`;

// Counted over every note in the report, missed ones included: the match
// window is wider than the criterion, so "within" is not already a given.
export function counts(a: Alignment, s: ReviewSettings, c: Context) {
  let within = 0, early = 0, late = 0, missed = 0;
  for (const n of a.notes) {
    if (n.status !== 'played') { missed++; continue; }
    const o = outside(n, s, c);
    if (o === 'early') early++;
    else if (o === 'late') late++;
    else within++;
  }
  return { within, early, late, missed, total: a.notes.length };
}

export function summary(a: Alignment, s: ReviewSettings, c: Context): string {
  const played = a.notes.filter((n) => n.status === 'played');
  switch (s.layer) {
    case 'notes': {
      const k = counts(a, s, c);
      const wrong = a.notes.filter((n) => n.wrongPitch !== undefined).length;
      const extras = a.extras.filter((x) => !x.wrongFor).length;
      const parts = [
        `${k.within} / ${k.total} ${withinLabel(s)}`, `${k.early} early`, `${k.late} late`,
        `${k.missed} missed${wrong ? ` (${wrong} wrong key)` : ''}`, `${extras} extra`,
      ];
      if (!played.length) return [...parts, ...offsetPart(s, c)].join(' · ');
      const fmt = (ns: PlayedNote[]) => {
        const t = ns.map((n) => timing(n, c));
        return `${signed(quantile(t.map((x) => x.pct), 0.5))} % (${signed(quantile(t.map((x) => x.ms), 0.5))} ms)`;
      };
      const rh = played.filter((n) => n.expected.staff === 1);
      const lh = played.filter((n) => n.expected.staff === 2);
      parts.push(`median ${fmt(played)}`);
      if (rh.length && lh.length) parts.push(`RH ${fmt(rh)}`, `LH ${fmt(lh)}`);
      if (c.beatMs) parts.push(`1 beat = ${Math.round(c.beatMs)} ms`);
      return [...parts, ...offsetPart(s, c)].join(' · ');
    }
    case 'duration':
      return byHand(played, (n) => n.durationPct, (x) => `${x.toFixed(0)} %`);
    case 'velocity':
      return byHand(played, (n) => n.velocityPct, (x) => `${x.toFixed(0)} %`);
    case 'pedal': {
      if (!a.pedals.length) return 'no pedal signs in these bars';
      const down = a.pedals.filter((p) => p.deltaMs !== undefined);
      const t = down.map((p) => pedalTiming(p, c));
      const held = down.flatMap((p) => (p.durationPct === undefined ? [] : [p.durationPct]));
      const parts = [`down ${down.length} / ${a.pedals.length}`];
      if (t.length) parts.push(`${t.filter((x) => Math.abs(x.pct) <= s.within * 100).length} ${withinLabel(s)}`);
      if (t.length) parts.push(`median ${signed(quantile(t.map((x) => x.pct), 0.5))} % (${signed(quantile(t.map((x) => x.ms), 0.5))} ms)`);
      if (held.length) parts.push(`held median ${quantile(held, 0.5).toFixed(0)} %`);
      parts.push(`${a.pedalExtras.length} extra`);
      if (!a.pedalReceived) parts.push('no pedal signal from the piano');
      if (c.beatMs) parts.push(`1 beat = ${Math.round(c.beatMs)} ms`);
      return [...parts, ...offsetPart(s, c)].join(' · ');
    }
  }
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

// Everything about one note at once, for the tap popover.
export function describe(n: PlayedNote, s: ReviewSettings, c: Context): string {
  const name = pitchName(n.expected.pitch);
  if (n.status !== 'played') {
    return n.wrongPitch !== undefined ? `${name} · missed (played ${pitchName(n.wrongPitch)})` : `${name} · missed`;
  }
  const t = timing(n, c);
  const parts = [
    name,
    `${signed(t.ms)} ms (${signed(t.pct)} % of beat)`,
    n.heldMs === undefined ? 'still held' : `held ${n.heldMs.toFixed(0)} ms (${n.durationPct?.toFixed(0) ?? '—'} %)`,
    `vel ${n.velocity} (${n.velocityPct!.toFixed(0)} %)`,
  ];
  if (n.pedal) parts.push('pedal');
  const o = outside(n, s, c);
  if (o) parts.push(`outside ±${Math.round(s.within * 100)} % (${o})`);
  return parts.join(' · ');
}

// A pedalled span, from its Ped. or its * sign. A change sign is both: the
// span it ends, then the one it starts.
const held = (p: PlayedPedal) => (p.heldMs === undefined
  ? 'still down' : `held ${p.heldMs.toFixed(0)} ms (${p.durationPct?.toFixed(0) ?? '—'} %)`);

export function describePedal(ends: PlayedPedal | undefined, starts: PlayedPedal | undefined, c: Context): string {
  const parts: string[] = [];
  if (ends) parts.push(ends.deltaMs === undefined ? 'pedal up (*) · pedal wasn\'t down' : `pedal up (*) · ${held(ends)}`);
  if (starts) {
    if (starts.deltaMs === undefined) parts.push('pedal down (Ped.) · missed');
    else {
      const t = pedalTiming(starts, c);
      parts.push(`pedal down (Ped.) · ${signed(t.ms)} ms (${signed(t.pct)} % of beat)`);
      if (!starts.end) parts.push(held(starts));
    }
  }
  return parts.join(' · ');
}
