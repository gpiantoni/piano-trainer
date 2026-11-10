import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningChord } from '../src/engine/opening.ts';
import type { NoteEvent } from '../src/types.ts';

const on = (pitch: number, t = 0): NoteEvent => ({ type: 'on', pitch, velocity: 64, t });
const off = (pitch: number, t = 0): NoteEvent => ({ type: 'off', pitch, velocity: 0, t });
const pedal = (down: boolean, t = 0): NoteEvent => ({ type: 'pedal', down, t });

const chord = [45, 60, 64];   // A2 in the left hand, C4 E4 in the right

test('opening chord: starts once all of it is down at once, in any order', () => {
  const o = new OpeningChord();
  // One key at a time, each let go before the next: never.
  for (const p of chord) {
    assert.equal(o.handle(chord, on(p)), undefined);
    o.handle(chord, off(p));
  }
  assert.equal(o.handle(chord, on(64, 10)), undefined);
  assert.equal(o.handle(chord, on(45, 20)), undefined);
  assert.deepEqual(o.handle(chord, on(60, 30)), [on(64, 10), on(45, 20), on(60, 30)]);
  // Then it starts over: the keys still down must be struck again.
  assert.equal(o.handle(chord, on(60, 40)), undefined);
});

test('opening chord: another key down at the same time stops it', () => {
  const o = new OpeningChord();
  o.handle(chord, on(45)); o.handle(chord, on(62)); o.handle(chord, on(64));
  assert.equal(o.handle(chord, on(60)), undefined);
  o.handle(chord, off(62));
  assert.deepEqual(o.handle(chord, on(60, 50))?.map((e) => e.t), [0, 0, 50]);
});

test('opening chord: keys held from before the reset must be struck again', () => {
  const o = new OpeningChord();
  o.handle(chord, on(60)); o.handle(chord, on(64));   // the run before ends on them, held
  o.reset();
  assert.equal(o.handle(chord, on(45, 100)), undefined);   // 60 and 64 are down, but from before
  o.handle(chord, off(60)); o.handle(chord, on(60, 110));
  o.handle(chord, off(64));
  assert.deepEqual(o.handle(chord, on(64, 120))?.map((e) => e.t), [100, 110, 120]);
});

test('opening chord: a re-struck key counts with its latest press; the pedal comes along if down', () => {
  const o = new OpeningChord();
  o.handle(chord, pedal(true, 5));
  o.handle(chord, on(60, 10)); o.handle(chord, off(60, 15)); o.handle(chord, on(60, 20));
  o.handle(chord, on(45, 25));
  assert.deepEqual(o.handle(chord, on(64, 30)), [pedal(true, 5), on(60, 20), on(45, 25), on(64, 30)]);

  for (const p of chord) o.handle(chord, off(p, 35));
  o.handle(chord, pedal(true, 40)); o.handle(chord, pedal(false, 45));   // up again: not in the events
  o.handle(chord, on(45, 50)); o.handle(chord, on(60, 50));
  assert.deepEqual(o.handle(chord, on(64, 50)), [on(45, 50), on(60, 50), on(64, 50)]);
});

test('opening chord: a single note and a unison are one key; no chord never starts', () => {
  const o = new OpeningChord();
  assert.deepEqual(o.handle([64], on(64)), [on(64)]);
  assert.deepEqual(o.handle([60, 60], on(60)), [on(60)]);
  assert.equal(o.handle([], on(60)), undefined);
});
