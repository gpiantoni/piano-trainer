import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaitMode } from '../src/engine/waitMode.ts';
import type { ExpectedEvent, NoteEvent, Staff } from '../src/types.ts';

const note = (id: string, pitch: number, onMs: number, staff: Staff = 1): ExpectedEvent => ({
  id, tiedIds: [], pitch, onMs, offMs: onMs + 500, beatMs: 500, staff, measure: 0,
});
const on = (pitch: number): NoteEvent => ({ type: 'on', pitch, velocity: 64, t: 0 });
const off = (pitch: number): NoteEvent => ({ type: 'off', pitch, velocity: 0, t: 0 });

// An A minor chord across both hands, then a C major one sharing its C4.
const score = [
  note('a2', 45, 0, 2), note('c4', 60, 0), note('e4', 64, 0),
  note('c3', 48, 500, 2), note('c4b', 60, 500), note('g4', 67, 500),
];

test('wait mode: a chord counts only with all of it down at once, both hands', () => {
  const w = new WaitMode(score);
  // One note at a time: each let go before the next.
  for (const p of [45, 60, 64]) assert.deepEqual([...w.handle(on(p)), ...w.handle(off(p))], []);
  assert.equal(w.cursor, 0);
  assert.equal(w.noteStates().get('c4'), undefined);   // nothing green yet

  // Built up and held: advances on the last key, whichever hand.
  w.handle(on(64)); w.handle(on(60));
  assert.deepEqual(w.expected, [45]);
  assert.deepEqual(w.handle(on(45)), [{ kind: 'advance', chord: 1 }]);
  assert.equal(w.noteStates().get('c4'), 'hit');
  assert.equal(w.wrong, 0);

  // C4 still held from the first chord doesn't count for the second: strike it again.
  w.handle(on(48)); w.handle(on(67));
  assert.deepEqual(w.expected, [60]);
  w.handle(off(60));
  assert.deepEqual(w.handle(on(60)), [{ kind: 'done' }]);
});

test('wait mode: a wrong key is counted and names the notes not yet down', () => {
  const w = new WaitMode(score);
  w.handle(on(60));
  assert.deepEqual(w.handle(on(62)), [{ kind: 'wrong', pitch: 62, expected: [45, 64] }]);
  assert.equal(w.wrong, 1);
  assert.deepEqual(w.handle(on(60)), []);    // re-striking a chord note is not a mistake
});

test('wait mode: one hand asks only for its own notes', () => {
  const w = new WaitMode(score, 'left');
  assert.deepEqual(w.handle(on(45)), [{ kind: 'advance', chord: 1 }]);
  assert.equal(w.noteStates().get('c4'), 'muted');
});
