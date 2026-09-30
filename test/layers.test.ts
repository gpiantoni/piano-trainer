import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align } from '../src/engine/align.ts';
import { DEFAULT_SETTINGS, context, counts, outside, summary, windowOf, type ReviewSettings } from '../src/review/layers.ts';
import type { ExpectedEvent, NoteEvent } from '../src/types.ts';

// A quarter-note melody at 120 BPM (beat = 500 ms), one pitch per note, each
// played `offsets[i]` ms off its onset.
const BEAT = 500;
function run(offsets: (number | null)[], s: ReviewSettings, biasMs = 0) {
  const events: ExpectedEvent[] = offsets.map((_, i) => ({
    id: `n${i}`, tiedIds: [], pitch: 60 + i, staff: 1,
    onMs: i * BEAT, offMs: (i + 1) * BEAT, beatMs: BEAT, measure: 0,
  }));
  const recording: NoteEvent[] = offsets.flatMap((d, i) => (d === null ? [] : [
    { type: 'on' as const, pitch: 60 + i, velocity: 64, t: i * BEAT + d },
    { type: 'off' as const, pitch: 60 + i, velocity: 0, t: i * BEAT + d + 400 },
  ]));
  const a = align(events, recording, 1, { maxOffsetBeats: windowOf(s), biasMs });
  const c = context(a, s, 1, { ms: biasMs || undefined, notes: a.notes.length });
  return { a, c, at: (i: number) => outside(a.notes[i], s, c) };
}

const strict = { ...DEFAULT_SETTINGS, within: 0.1 };
const relaxed = { ...DEFAULT_SETTINGS, within: 0.2 };

test('the criterion pairs with a wider match window', () => {
  assert.equal(windowOf(strict), 0.3);
  assert.equal(windowOf(relaxed), 0.5);
});

test('outside the criterion: early or late, by the sign of the offset', () => {
  // +9 %, +11 %, −11 % of a beat
  const { at } = run([45, 55, -55], strict);
  assert.equal(at(0), undefined);
  assert.equal(at(1), 'late');
  assert.equal(at(2), 'early');
  assert.equal(run([45, 55, -55], relaxed).at(1), undefined);
});

test('re-center moves the criterion with the window', () => {
  // +15 % raw is outside ±10 %, but only +5 % from a +10 % (50 ms) run offset.
  const s = { ...strict, recenter: true };
  assert.equal(run([75], strict).at(0), 'late');
  assert.equal(run([75], s, 50).at(0), undefined);
});

test('counts cover every expected note, missed ones included', () => {
  // within, within, late, early, beyond the 30 % window (missed), not played
  const { a, c } = run([0, 20, 125, -80, 200, null], strict);
  const k = counts(a, strict, c);
  assert.deepEqual(k, { within: 2, early: 1, late: 1, missed: 2, total: 6 });
  assert.equal(k.within + k.early + k.late + k.missed, k.total);
  assert.match(summary(a, strict, c), /^2 \/ 6 within ±10 % · 1 early · 1 late · 2 missed · 1 extra/);
});
