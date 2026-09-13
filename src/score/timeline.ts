import type { VerovioToolkit } from 'verovio/esm';
import type { ExpectedEvent } from '../types.ts';

type TimemapEntry = {
  tstamp: number;     // ms at the score's own tempo
  qstamp: number;     // quarter notes
  on?: string[];
  off?: string[];
  tempo?: number;
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

// Requires a score already loaded into `tk`. Note ids are regenerated on every
// load, so rebuild the timeline whenever the score is (re)loaded.
export function buildTimeline(tk: VerovioToolkit): ExpectedEvent[] {
  tk.renderToMIDI();   // required before getMIDIValuesForElement
  const raw = tk.renderToTimemap({ includeMeasures: false, includeRests: false });
  const map: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assertTimemap(map);

  const tieStartOf = tieLinks(tk.getMEI());
  const root = (id: string) => {
    let cur = id;
    for (let s = tieStartOf.get(cur); s; s = tieStartOf.get(cur)) cur = s;   // chains a→b→c
    return cur;
  };

  const onAt = new Map<string, number>();
  const offAt = new Map<string, number>();
  for (const entry of map) {
    for (const id of entry.on ?? []) if (!onAt.has(id)) onAt.set(id, entry.tstamp);
    for (const id of entry.off ?? []) offAt.set(id, entry.tstamp);
  }

  const events = new Map<string, ExpectedEvent>();
  for (const [id, onMs] of onAt) {
    if (root(id) !== id) continue;                  // continuation of a tie
    const midi = tk.getMIDIValuesForElement(id) as { pitch?: number } | string;
    const pitch = (typeof midi === 'string' ? JSON.parse(midi) : midi).pitch;
    if (typeof pitch !== 'number') continue;
    events.set(id, { id, tiedIds: [], pitch, onMs, offMs: offAt.get(id) ?? onMs });
  }
  for (const id of onAt.keys()) {
    const ev = events.get(root(id));
    if (!ev || ev.id === id) continue;
    ev.tiedIds.push(id);
    ev.offMs = Math.max(ev.offMs, offAt.get(id) ?? ev.offMs);
  }

  return [...events.values()].sort((a, b) => a.onMs - b.onMs || a.pitch - b.pitch);
}
