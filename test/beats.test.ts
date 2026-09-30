import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBeats, buildMeasures, buildSubdivisions, countIn } from '../src/score/beats.ts';
import type { TimemapEntry } from '../src/score/beats.ts';

// A quarter note is 500 ms (♩ = 120) throughout; bar starts at the given qstamps.
function grid(count: number, unit: number, barStarts: number[], endQ: number) {
  const map: TimemapEntry[] = [
    ...barStarts.map((q, i) => ({ qstamp: q, tstamp: q * 500, measureOn: `m${i}`, ...(i === 0 ? { tempo: 120 } : {}) })),
    { qstamp: endQ, tstamp: endQ * 500 },
  ];
  const meters = new Map([['m0', { count, unit }]]);
  const measures = buildMeasures(map, meters);
  const beats = buildBeats(measures, map);
  return { measures, beats, subs: buildSubdivisions(measures, map), countIn: countIn(measures, beats, map) };
}

test('4/4: one "and" halfway between beats', () => {
  const { beats, subs } = grid(4, 4, [0], 4);
  assert.deepEqual(beats.map((b) => b.t), [0, 500, 1000, 1500]);
  assert.deepEqual(subs, [250, 750, 1250, 1750]);
});

test('6/8: two beats a bar, and the eighths between them', () => {
  const { beats, subs, countIn: ci } = grid(6, 8, [0, 3], 6);
  assert.deepEqual(beats.map((b) => [b.t, b.downbeat]), [[0, true], [750, false], [1500, true], [2250, false]]);
  assert.deepEqual(subs, [250, 500, 1000, 1250, 1750, 2000, 2500, 2750]);
  assert.deepEqual(ci.map((c) => [c.t, c.accent, !!c.sub]), [
    [-1500, true, false], [-1250, false, true], [-1000, false, true],
    [-750, false, false], [-500, false, true], [-250, false, true],
  ]);
});

test('6/8 pickup of one beat: its eighths still click', () => {
  // Bar 0 holds only the last beat (1.5 quarters) of a full bar.
  const { beats, subs } = grid(6, 8, [0, 1.5], 4.5);
  assert.deepEqual(beats.map((b) => b.t), [0, 750, 1500]);
  assert.deepEqual(subs, [250, 500, 1000, 1250, 1750, 2000]);
});
