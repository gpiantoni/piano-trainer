import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSection, inWindow, parseSection, playWindow, sectionFrom, sectionLabel } from '../src/score/section.ts';
import { TempoRun } from '../src/engine/tempoRun.ts';
import { align } from '../src/engine/align.ts';
import type { ScoreTiming } from '../src/score/timeline.ts';
import type { ExpectedEvent, NoteEvent } from '../src/types.ts';

// Four bars of 3/4 at 120 BPM (beat 500 ms, bar 1500 ms), printed 1–4, one
// quarter note per beat: pitches 60, 61, 62, … in order.
const BEAT = 500, BAR = 1500;
function timing(): ScoreTiming {
  const meter = { count: 3, unit: 4 };
  const measures = [0, 1, 2, 3].map((i) => ({
    id: `m${i}`, n: String(i + 1), startQ: i * 3, endQ: (i + 1) * 3, startMs: i * BAR, endMs: (i + 1) * BAR, meter,
  }));
  const beats = Array.from({ length: 12 }, (_, k) => ({ t: k * BEAT, downbeat: k % 3 === 0, measure: Math.floor(k / 3) }));
  const events: ExpectedEvent[] = beats.map((b, k) => ({
    id: `n${k}`, tiedIds: [], pitch: 60 + k, onMs: b.t, offMs: b.t + BEAT, staff: 1, beatMs: BEAT, measure: b.measure,
  }));
  return {
    events, measures, beats, subdivisions: [], onsets: [], pedals: [], bpm: 120, endMs: 4 * BAR,
    countIn: [-3, -2, -1].map((k) => ({ t: k * BEAT, accent: k === -3 })),
  };
}

test('whole piece: the score\'s own count-in and end', () => {
  const t = timing();
  const w = playWindow(t);
  assert.deepEqual([w.startMs, w.endMs, w.countIn], [0, 4 * BAR, t.countIn]);
  assert.equal(w.section, undefined);
});

test('a section in the middle: one bar of count-in before its downbeat', () => {
  const t = timing();
  const w = playWindow(t, { from: 1, to: 2 });
  assert.deepEqual([w.startMs, w.endMs], [BAR, 3 * BAR]);
  assert.deepEqual(w.countIn, [
    { t: 0, accent: true }, { t: 250, accent: false, sub: true },
    { t: 500, accent: false }, { t: 750, accent: false, sub: true },
    { t: 1000, accent: false }, { t: 1250, accent: false, sub: true },
  ]);
  assert.equal(inWindow(w, BAR), true);
  assert.equal(inWindow(w, BAR - 1), false);
  assert.equal(inWindow(w, 3 * BAR), false);      // the next bar's downbeat is outside
});

test('a section from the first bar keeps the piece\'s count-in (pickups)', () => {
  const t = timing();
  assert.deepEqual(playWindow(t, { from: 0, to: 1 }).countIn, t.countIn);
});

test('taps in either order, labels with printed numbers, storage round trip', () => {
  const t = timing();
  assert.deepEqual(sectionFrom(3, 1), { from: 1, to: 3 });
  assert.equal(sectionLabel(t, { from: 1, to: 3 }), 'Bars 2–4');
  assert.equal(sectionLabel(t, { from: 2, to: 2 }), 'Bar 3');
  assert.deepEqual(parseSection(formatSection({ from: 1, to: 2 }), 4), { from: 1, to: 2 });
  assert.equal(parseSection('1-9', 4), undefined);   // the score changed: bar 9 is gone
  assert.equal(parseSection('3-1', 4), undefined);
  assert.equal(parseSection(null, 4), undefined);
});

test('tempo run over a section: clicks, phases and end', () => {
  const t = timing();
  const speed = 0.5, now = 10_000;
  const run = new TempoRun(t, speed, 0, playWindow(t, { from: 1, to: 2 }), now);
  // First count-in click (score 0 ms) 300 ms after start; section downbeat 1 bar later.
  assert.equal(run.realAt(0), now + 300);
  assert.equal(run.realAt(BAR), now + 300 + BAR / speed);
  const always = run.clicks.filter((c) => c.always), beats = run.clicks.filter((c) => !c.always);
  assert.equal(always.length, 6);                   // one bar of count-in, "and" after each beat
  assert.equal(beats.length, 6);                    // two bars of three
  assert.equal(beats[0].at, run.realAt(BAR));
  assert.equal(run.phase(run.realAt(BAR) - 1), 'countIn');
  assert.equal(run.phase(run.realAt(BAR) + 1), 'playing');
  assert.equal(run.phase(run.realAt(3 * BAR + BEAT) + 1), 'finished');
});

test('align over a section: only its notes, no extras from the count-in', () => {
  const t = timing();
  const w = playWindow(t, { from: 1, to: 1 });
  const rec: NoteEvent[] = [
    { type: 'on', pitch: 99, velocity: 50, t: 100 }, { type: 'off', pitch: 99, velocity: 0, t: 200 },  // noodling in the count-in
  ];
  for (const e of t.events.filter((e) => e.measure === 1)) {
    rec.push({ type: 'on', pitch: e.pitch, velocity: 60, t: e.onMs + 20 }, { type: 'off', pitch: e.pitch, velocity: 0, t: e.onMs + 400 });
  }
  const a = align(t.events, rec, 1, { window: w });
  assert.deepEqual(a.notes.map((n) => [n.expected.id, n.status]), [['n3', 'played'], ['n4', 'played'], ['n5', 'played']]);
  assert.equal(a.extras.length, 0);
});
