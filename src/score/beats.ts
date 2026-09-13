// Measures, meters and beat times: what the metronome, the count-in and the
// per-note beat length need. Pure functions over the verovio timemap + MEI.

export type TimemapEntry = {
  tstamp: number;       // ms at the score's own tempo
  qstamp: number;       // quarter notes
  on?: string[];
  off?: string[];
  restsOn?: string[];
  restsOff?: string[];
  measureOn?: string;
  tempo?: number;       // quarter-note BPM, only where it changes
};

export type Meter = { count: number; unit: number };

export type Measure = {
  id: string;
  startMs: number;
  endMs: number;
  startQ: number;
  endQ: number;
  meter: Meter;
};

export type Beat = { t: number; downbeat: boolean; measure: number };

const EPS = 1e-6;

// 6/8, 9/8, 12/8 (and /16) are felt in dotted beats of three.
const compound = (m: Meter) => m.unit >= 8 && m.count > 3 && m.count % 3 === 0;
export const beatQ = (m: Meter) => (compound(m) ? 3 : 1) * (4 / m.unit);
export const beatsPerBar = (m: Meter) => (compound(m) ? m.count / 3 : m.count);

// measure id -> meter in effect. Meters come from <meterSig> or the older
// meter.count/meter.unit attributes on scoreDef/staffDef, in document order.
export function metersByMeasure(mei: string): Map<string, Meter> {
  const out = new Map<string, Meter>();
  let meter: Meter = { count: 4, unit: 4 };
  for (const [tag, name] of mei.matchAll(/<(meterSig|scoreDef|staffDef|measure)\b[^>]*>/g)) {
    if (name === 'measure') {
      const id = tag.match(/xml:id="([^"]+)"/)?.[1];
      if (id) out.set(id, meter);
      continue;
    }
    const prefix = name === 'meterSig' ? '' : 'meter\\.';
    const count = Number(tag.match(new RegExp(`\\s${prefix}count="(\\d+)`))?.[1]);
    const unit = Number(tag.match(new RegExp(`\\s${prefix}unit="(\\d+)"`))?.[1]);
    if (count && unit) meter = { count, unit };
  }
  return out;
}

// Quarter-note position -> ms at 1.0×: linear between timemap entries, and
// extrapolated with the tempo in effect before the start and after the end.
export function qToMs(map: TimemapEntry[]): (q: number) => number {
  const pts: { q: number; t: number; tempo: number }[] = [];
  let tempo = map.find((e) => e.tempo)?.tempo ?? 120;
  for (const e of map) {
    tempo = e.tempo ?? tempo;
    if (pts.length && e.qstamp <= pts[pts.length - 1].q) continue;
    pts.push({ q: e.qstamp, t: e.tstamp, tempo });
  }
  if (pts.length === 0) return (q) => (q * 60000) / tempo;
  return (q) => {
    const first = pts[0], last = pts[pts.length - 1];
    if (q <= first.q) return first.t + ((q - first.q) * 60000) / first.tempo;
    if (q >= last.q) return last.t + ((q - last.q) * 60000) / last.tempo;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].q <= q) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    return a.t + ((b.t - a.t) * (q - a.q)) / (b.q - a.q);
  };
}

export function buildMeasures(map: TimemapEntry[], meters: Map<string, Meter>): Measure[] {
  const toMs = qToMs(map);
  const lastQ = map.reduce((m, e) => Math.max(m, e.qstamp), 0);
  const starts = map.filter((e) => e.measureOn);
  let meter: Meter = { count: 4, unit: 4 };
  return starts.map((e, i) => {
    meter = meters.get(e.measureOn!) ?? meter;
    const startQ = e.qstamp;
    let endQ = starts[i + 1]?.qstamp ?? lastQ;
    if (endQ <= startQ + EPS) endQ = startQ + beatsPerBar(meter) * beatQ(meter);
    return { id: e.measureOn!, startQ, endQ, startMs: toMs(startQ), endMs: toMs(endQ), meter };
  });
}

// A first bar shorter than its meter is a pickup (anacrusis).
export function isPickup(measures: Measure[]): boolean {
  const m = measures[0];
  return !!m && m.endQ - m.startQ < beatsPerBar(m.meter) * beatQ(m.meter) - EPS;
}

export function buildBeats(measures: Measure[], map: TimemapEntry[]): Beat[] {
  const toMs = qToMs(map);
  const beats: Beat[] = [];
  measures.forEach((m, i) => {
    const step = beatQ(m.meter);
    const qs: number[] = [];
    if (i === 0 && isPickup(measures)) {
      // A pickup holds the *last* beats of a full bar.
      for (let q = m.endQ - step; q >= m.startQ - EPS; q -= step) qs.unshift(q);
    } else {
      for (let q = m.startQ; q < m.endQ - EPS; q += step) qs.push(q);
    }
    for (const q of qs) {
      beats.push({ t: toMs(q), downbeat: Math.abs(q - m.startQ) < EPS && !(i === 0 && isPickup(measures)), measure: i });
    }
  });
  return beats;
}

// Count-in clicks before the first beat: one full bar, plus the beats a pickup
// bar is missing, so the first note falls where the ear expects it. Offsets are
// score ms at 1.0× (negative, before the first beat); divide by speed for real ms.
export function countIn(measures: Measure[], beats: Beat[], map: TimemapEntry[]): { t: number; accent: boolean }[] {
  const first = measures[0];
  if (!first || beats.length === 0) return [];
  const perBar = beatsPerBar(first.meter);
  const inPickup = isPickup(measures) ? beats.filter((b) => b.measure === 0).length : 0;
  const n = perBar + (inPickup ? perBar - inPickup : 0);
  const toMs = qToMs(map);
  const beatMs = toMs(first.startQ + beatQ(first.meter)) - toMs(first.startQ);
  const out = [];
  for (let k = n; k >= 1; k--) out.push({ t: beats[0].t - k * beatMs, accent: (n - k) % perBar === 0 });
  return out;
}

// Index of the last item whose time is <= t (or -1).
export function lastAtOrBefore<T>(items: T[], t: number, time: (x: T) => number): number {
  let lo = 0, hi = items.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid]) <= t + EPS) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
