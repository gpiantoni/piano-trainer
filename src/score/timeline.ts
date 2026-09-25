import type { VerovioToolkit } from 'verovio/esm';
import type { ExpectedEvent, PedalMark, Staff } from '../types.ts';
import {
  buildBeats, buildMeasures, buildSubdivisions, countIn, lastAtOrBefore, measureNumbers, metersByMeasure, qToMs,
  type Beat, type Measure, type TimemapEntry,
} from './beats.ts';

// Everything the app knows about *when*, at the score's own tempo (1.0×).
export type ScoreTiming = {
  events: ExpectedEvent[];
  measures: Measure[];
  beats: Beat[];
  subdivisions: number[];                     // "and" ticks halfway between beats
  countIn: { t: number; accent: boolean; sub?: boolean }[];   // before score time 0, 1.0× ms
  onsets: { t: number; ids: string[] }[];     // notes and rests starting together: cursor anchors
  pedals: PedalMark[];                        // in time order; up before down at the same time
  bpm: number;                                // quarter-note tempo at the start
  endMs: number;
};

// The timemap shape is not formally documented; fail loudly if it drifts.
function assertTimemap(map: unknown): asserts map is TimemapEntry[] {
  if (!Array.isArray(map) || map.some((e) => typeof e?.tstamp !== 'number')) {
    throw new Error('unexpected verovio timemap shape');
  }
}

// tie end id -> tie start id. Verovio's MusicXML import writes <tie startid endid>.
function tieLinks(mei: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const [tag] of mei.matchAll(/<tie\b[^>]*>/g)) {
    const start = tag.match(/startid="#([^"]+)"/)?.[1];
    const end = tag.match(/endid="#([^"]+)"/)?.[1];
    if (start && end) links.set(end, start);
  }
  return links;
}

// note id -> staff (hand). Notes sit inside <staff n>; a cross-staff note or
// chord carries its own staff="…", which wins. The SVG has no staff numbers.
function staffLinks(mei: string): Map<string, Staff> {
  const links = new Map<string, Staff>();
  let staff = 1;
  let chordStaff: number | undefined;
  for (const [tag, name] of mei.matchAll(/<\/?(staff|chord|note)\b[^>]*>/g)) {
    const own = Number(tag.match(/\sstaff="(\d+)"/)?.[1]) || undefined;
    if (tag.startsWith('</')) {
      if (name === 'chord') chordStaff = undefined;
    } else if (name === 'staff') {
      staff = Number(tag.match(/\sn="(\d+)"/)?.[1]) || 1;
    } else if (name === 'chord') {
      if (!tag.endsWith('/>')) chordStaff = own;
    } else {
      const id = tag.match(/xml:id="([^"]+)"/)?.[1];
      if (id) links.set(id, (own ?? chordStaff ?? staff) >= 2 ? 2 : 1);
    }
  }
  return links;
}

type PedalSign = { id: string; down: boolean; tstamp?: number; startid?: string };

// measure id -> its pedal signs. Verovio's MusicXML import writes
// <pedal dir="down|up|bounce" tstamp>; other MEI may anchor a sign to a note
// (startid), or give a down its release as tstamp2="<bars>m+<beat>".
function pedalSigns(mei: string): Map<string, PedalSign[]> {
  const out = new Map<string, PedalSign[]>();
  const order: string[] = [];
  const add = (measure: string | undefined, sign: PedalSign) => {
    if (!measure) return;
    if (!out.has(measure)) out.set(measure, []);
    out.get(measure)!.push(sign);
  };
  const later: { from: number; bars: number; sign: PedalSign }[] = [];
  for (const [tag, name] of mei.matchAll(/<(measure|pedal)\b[^>]*>/g)) {
    const attr = (a: string) => tag.match(new RegExp(`\\s${a}="([^"]+)"`))?.[1];
    if (name === 'measure') { const id = attr('xml:id'); if (id) order.push(id); continue; }
    const id = attr('xml:id'), dir = attr('dir');
    if (!id || !dir) continue;
    const tstamp = Number(attr('tstamp')) || undefined;
    const startid = attr('startid')?.replace(/^#/, '');
    if (dir === 'up' || dir === 'bounce') add(order.at(-1), { id, down: false, tstamp, startid });
    if (dir === 'down' || dir === 'bounce') add(order.at(-1), { id, down: true, tstamp, startid });
    const end = attr('tstamp2')?.match(/^(\d+)m\+([\d.]+)$/);
    if (dir === 'down' && end) later.push({ from: order.length - 1, bars: Number(end[1]), sign: { id, down: false, tstamp: Number(end[2]) } });
  }
  for (const { from, bars, sign } of later) add(order[from + bars], sign);
  return out;
}

// Pedal signs at score times, in performance order: a repeated bar repeats its
// signs. A tstamp of the bar's last beat + .9 is verovio's "at the barline".
function pedalMarks(
  mei: string, measures: Measure[], map: TimemapEntry[], onAt: Map<string, number>, beatMsAt: (t: number) => number,
): PedalMark[] {
  const signs = pedalSigns(mei);
  const toMs = qToMs(map);
  const firstStart = new Map<string, number>();
  for (const m of measures) if (!firstStart.has(m.id)) firstStart.set(m.id, m.startMs);
  const marks: PedalMark[] = [];
  for (const m of measures) {
    for (const s of signs.get(m.id) ?? []) {
      let t: number | undefined;
      if (s.tstamp !== undefined) {
        const q = s.tstamp >= m.meter.count + 0.9 - 1e-6 ? m.endQ : m.startQ + (s.tstamp - 1) * (4 / m.meter.unit);
        t = toMs(Math.min(q, m.endQ));
      } else if (s.startid && onAt.has(s.startid)) {
        t = m.startMs + onAt.get(s.startid)! - firstStart.get(m.id)!;
      }
      if (t !== undefined) marks.push({ id: s.id, down: s.down, t, beatMs: beatMsAt(t) });
    }
  }
  return marks.sort((a, b) => a.t - b.t || Number(a.down) - Number(b.down));
}

// Requires a score already loaded into `tk`. Note ids are regenerated on every
// load, so rebuild the timeline whenever the score is (re)loaded.
export function buildTimeline(tk: VerovioToolkit): ScoreTiming {
  tk.renderToMIDI();   // required before getMIDIValuesForElement
  const raw = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
  const map: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assertTimemap(map);

  const mei = tk.getMEI();
  const tieStartOf = tieLinks(mei);
  const staffOf = staffLinks(mei);
  const root = (id: string) => {
    let cur = id;
    for (let s = tieStartOf.get(cur); s; s = tieStartOf.get(cur)) cur = s;   // chains a→b→c
    return cur;
  };

  const onAt = new Map<string, number>();
  const offAt = new Map<string, number>();
  for (const entry of map) {
    for (const id of entry.on ?? []) if (!onAt.has(id)) onAt.set(id, entry.tstamp);
    // First pass only: with repeats the same id sounds again later (see plan).
    for (const id of entry.off ?? []) if (!offAt.has(id)) offAt.set(id, entry.tstamp);
  }

  const events = new Map<string, ExpectedEvent>();
  for (const [id, onMs] of onAt) {
    if (root(id) !== id) continue;                  // continuation of a tie
    const midi = tk.getMIDIValuesForElement(id) as { pitch?: number } | string;
    const pitch = (typeof midi === 'string' ? JSON.parse(midi) : midi).pitch;
    if (typeof pitch !== 'number') continue;
    events.set(id, {
      id, tiedIds: [], pitch, onMs, offMs: offAt.get(id) ?? onMs,
      staff: staffOf.get(id) ?? 1, beatMs: 0, measure: 0,
    });
  }
  for (const id of onAt.keys()) {
    const ev = events.get(root(id));
    if (!ev || ev.id === id) continue;
    ev.tiedIds.push(id);
    ev.offMs = Math.max(ev.offMs, offAt.get(id) ?? ev.offMs);
  }

  const measures = buildMeasures(map, metersByMeasure(mei), measureNumbers(mei));
  const beats = buildBeats(measures, map);
  const sorted = [...events.values()].sort((a, b) => a.onMs - b.onMs || a.pitch - b.pitch);
  const beatMsAt = (t: number) => {
    const i = Math.max(0, lastAtOrBefore(beats, t, (b) => b.t));
    const next = beats[i + 1]?.t ?? (beats[i] && beats[i - 1] ? 2 * beats[i].t - beats[i - 1].t : NaN);
    return beats[i] && next > beats[i].t ? next - beats[i].t : 60000 / (map[0]?.tempo ?? 120);
  };
  for (const ev of sorted) {
    ev.beatMs = beatMsAt(ev.onMs);
    ev.measure = Math.max(0, lastAtOrBefore(measures, ev.onMs, (m) => m.startMs));
  }

  const onsets = map
    .map((e) => ({ t: e.tstamp, ids: [...(e.on ?? []), ...(e.restsOn ?? [])] }))
    .filter((o) => o.ids.length > 0);

  return {
    events: sorted,
    measures,
    beats,
    subdivisions: buildSubdivisions(measures, map),
    countIn: countIn(measures, beats, map),
    onsets,
    pedals: pedalMarks(mei, measures, map, onAt, beatMsAt),
    bpm: map.find((e) => e.tempo)?.tempo ?? 120,
    endMs: Math.max(measures.at(-1)?.endMs ?? 0, ...sorted.map((e) => e.offMs)),
  };
}
