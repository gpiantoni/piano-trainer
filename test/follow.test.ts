import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseFollow, type FollowOptions } from '../src/engine/follow.ts';
import type { ExpectedEvent, NoteEvent, PedalMark, PlayedNote, Staff } from '../src/types.ts';

// Quarter notes at 120 BPM (beat = 500 ms), speed 1, the ±20 % criterion's
// 0.5-beat window. Real time starts at T0: only differences matter.
const BEAT = 500;
const T0 = 10_000;
const OPTS: FollowOptions = { hands: 'both', window: { startMs: -Infinity, endMs: Infinity }, pauseBeats: 0.5 };

const note = (id: string, pitch: number, onMs: number, staff: Staff = 1, dur = BEAT): ExpectedEvent => ({
  id, tiedIds: [], pitch, onMs, offMs: onMs + dur, beatMs: BEAT, staff, measure: Math.floor(onMs / (4 * BEAT)),
});
// n0, n1, …: C4 upwards, one per beat.
const melody = (n: number) => Array.from({ length: n }, (_, i) => note(`n${i}`, 60 + i, i * BEAT));

// A key down at t (ms after T0), up `hold` ms later.
const key = (pitch: number, t: number, hold = 400, velocity = 64): NoteEvent[] => [
  { type: 'on', pitch, velocity, t: T0 + t },
  { type: 'off', pitch, velocity: 0, t: T0 + t + hold },
];
const pedal = (down: number, up?: number): NoteEvent[] => [
  { type: 'pedal', down: true, t: T0 + down },
  ...(up === undefined ? [] : [{ type: 'pedal' as const, down: false, t: T0 + up }]),
];
// Events in time order, as they would arrive.
const rec = (...parts: NoteEvent[][]) => parts.flat().sort((a, b) => a.t - b.t);
// The melody's keys, n0 at `times[0]` and so on.
const playAt = (times: number[], hold = 400) => rec(...times.map((t, i) => key(60 + i, t, hold)));

const byId = (notes: PlayedNote[], id: string) => notes.find((n) => n.expected.id === id)!;
const near = (actual: number | undefined, expected: number, msg?: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${msg ?? ''} ${actual} ≉ ${expected}`);
const pauses = (notes: PlayedNote[]) => new Set(notes.filter((n) => n.restart === 'pause').map((n) => n.expected.onMs)).size;

test('steady: the first chord starts the clock, the rest are on time', () => {
  const a = analyseFollow(melody(4), playAt([0, 500, 1000, 1500]), 1, OPTS);
  assert.equal(a.notes.length, 4);
  assert.equal(a.notes[0].restart, 'first');
  assert.equal(a.notes[0].deltaMs, undefined);
  assert.equal(a.notes[0].status, 'played');
  for (const n of a.notes.slice(1)) { near(n.deltaMs, 0); assert.equal(n.restart, undefined); }
  assert.equal(pauses(a.notes), 0);
  near(a.notes[2].onsetMs, 1000, 'onset on the score axis');
});

test('late within the window: timed, and the clock does not move', () => {
  const a = analyseFollow(melody(4), playAt([0, 500, 1150, 1500]), 1, OPTS);
  near(byId(a.notes, 'n2').deltaPct, 30);
  near(byId(a.notes, 'n3').deltaMs, 0);
  assert.equal(pauses(a.notes), 0);
});

test('a stop: that chord is late, then restarts the clock; the next ones are timed from it', () => {
  const a = analyseFollow(melody(5), playAt([0, 500, 2500, 3000, 3550]), 1, OPTS);
  const n2 = byId(a.notes, 'n2');
  assert.equal(n2.restart, 'pause');
  near(n2.deltaMs, 1500, 'against the clock that was running');
  near(byId(a.notes, 'n3').deltaMs, 0);
  near(byId(a.notes, 'n4').deltaPct, 10);
  assert.equal(pauses(a.notes), 1);
});

test('the match window decides what is a pause', () => {
  const recording = playAt([0, 500, 1200]);   // n2 40 % late
  near(byId(analyseFollow(melody(3), recording, 1, OPTS).notes, 'n2').deltaPct, 40);
  const strict = byId(analyseFollow(melody(3), recording, 1, { ...OPTS, pauseBeats: 0.3 }).notes, 'n2');
  assert.equal(strict.restart, 'pause');
  near(strict.deltaPct, 40, 'a pause is as late either way');
});

test('drift is not forgiven: lateness grows until a pause', () => {
  const a = analyseFollow(melody(6), playAt([0, 575, 1150, 1725, 2300, 2875]), 1, OPTS);
  const pct = a.notes.map((n) => n.deltaPct);
  near(pct[1], 15); near(pct[2], 30); near(pct[3], 45);
  assert.equal(a.notes[4].restart, 'pause');
  near(pct[4], 60, 'the pause shows the worst of it');
  near(pct[5], 15);
});

test('early is timed, never a pause', () => {
  const a = analyseFollow(melody(3), playAt([0, 500, 650]), 1, OPTS);
  near(byId(a.notes, 'n2').deltaPct, -70);
  assert.equal(pauses(a.notes), 0);
});

test('each note of a chord is timed on its own', () => {
  const score = [note('l0', 48, 0, 2), note('r0', 60, 0), note('l1', 50, 500, 2), note('r1', 62, 500)];
  const a = analyseFollow(score, rec(key(48, 0), key(60, 0), key(50, 480), key(62, 520)), 1, OPTS);
  near(byId(a.notes, 'l1').deltaMs, -20);
  near(byId(a.notes, 'r1').deltaMs, 20);
});

test('chord onset is its earliest key: a hand found late is not a pause, but reads late', () => {
  const score = [note('l0', 48, 0, 2), note('r0', 60, 0), note('l1', 50, 500, 2), note('r1', 62, 500)];
  const recording = rec(key(48, 0), key(60, 0), key(50, 500, 1200), key(62, 1500));
  const a = analyseFollow(score, recording, 1, OPTS);
  assert.equal(pauses(a.notes), 0);
  near(byId(a.notes, 'r1').deltaPct, 200);
});

test('duration: real held time; none for a key held through a pause; the last chord measured', () => {
  const recording = rec(key(60, 0, 250), key(61, 500, 2100), key(62, 2500, 250));   // n2 after a stop
  const a = analyseFollow(melody(3), recording, 1, OPTS);
  near(byId(a.notes, 'n0').durationPct, 50);
  const n1 = byId(a.notes, 'n1');
  near(n1.heldMs, 2100);
  assert.equal(n1.durationPct, undefined);
  near(byId(a.notes, 'n2').heldMs, 250);
});

test('one hand: only its staff is asked for and reported', () => {
  const score = [note('l0', 48, 0, 2), note('r0', 60, 0), note('l1', 50, 500, 2), note('r1', 62, 500)];
  const a = analyseFollow(score, rec(key(48, 0), key(50, 500)), 1, { ...OPTS, hands: 'left' });
  assert.deepEqual(a.notes.map((n) => n.expected.id), ['l0', 'l1']);
  near(byId(a.notes, 'l1').deltaMs, 0);
});

test('wrong keys: extras at the chord asked for; none before the run starts', () => {
  const recording = rec(key(70, -2000), key(60, 0), key(61, 500), key(71, 700, 100, 90), key(62, 1000));
  const a = analyseFollow(melody(3), recording, 1, OPTS);
  assert.equal(a.extras.length, 1);
  assert.deepEqual(a.extras[0], { pitch: 71, onsetMs: 1000, velocity: 90, velocityPct: (90 / 127) * 100 });
});

test('stopped early: only completed chords are reported', () => {
  const score = [...melody(3), note('x', 48, 1000, 2)];   // the last chord has two keys
  const a = analyseFollow(score, playAt([0, 500, 1000]), 1, OPTS);
  assert.deepEqual(a.notes.map((n) => n.expected.id), ['n0', 'n1']);
});

test('a unison is satisfied by one key: both notes get it', () => {
  const score = [note('l0', 60, 0, 2), note('r0', 60, 0), ...melody(2).slice(1)];
  const a = analyseFollow(score, rec(key(60, 0, 300, 80), key(61, 500)), 1, OPTS);
  assert.deepEqual(a.notes.slice(0, 2).map((n) => [n.expected.id, n.velocity, n.heldMs]), [['l0', 80, 300], ['r0', 80, 300]]);
});

test('a re-struck key counts with the press that completed the chord', () => {
  const score = [note('l0', 48, 0, 2), note('r0', 60, 0), ...melody(2).slice(1)];
  const recording = rec(key(60, 0, 50, 40), key(60, 100, 300, 80), key(48, 150), key(61, 600));
  const a = analyseFollow(score, recording, 1, OPTS);
  assert.equal(byId(a.notes, 'r0').velocity, 80);
  near(byId(a.notes, 'r0').heldMs, 300);
  near(byId(a.notes, 'n1').deltaMs, 0, 'clock from the chord onset, the first counted key (100)');
});

test('the practice speed sets the clock: the same playing, judged at another bpm', () => {
  const recording = playAt([0, 500, 1000]);
  const slow = analyseFollow(melody(3), recording, 0.5, OPTS);   // beat = 1000 real ms
  near(byId(slow.notes, 'n1').deltaPct, -50);
  assert.equal(pauses(slow.notes), 0);
  const fast = analyseFollow(melody(3), recording, 2, OPTS);     // beat = 250 real ms
  assert.equal(byId(fast.notes, 'n1').restart, 'pause');
  near(byId(fast.notes, 'n1').deltaPct, 100);
});

// Pedal signs: Ped. (down) and * (up).
const mark = (id: string, down: boolean, t: number): PedalMark => ({ id, down, t, beatMs: BEAT });

test('pedal: timed against the same clock', () => {
  const marks = [mark('p0', true, 500), mark('p1', false, 1500)];
  const a = analyseFollow(melody(4), rec(playAt([0, 500, 1000, 1500]), pedal(540, 1500)), 1, OPTS, marks);
  assert.equal(a.pedals.length, 1);
  near(a.pedals[0].deltaMs, 40);
  near(a.pedals[0].durationPct, 96);
  assert.equal(a.pedalReceived, true);
});

test('pedal before the first chord reads as early', () => {
  const marks = [mark('p0', true, 0), mark('p1', false, 1000)];
  const a = analyseFollow(melody(3), rec(playAt([0, 500, 1000]), pedal(-100, 900)), 1, OPTS, marks);
  near(a.pedals[0].deltaMs, -100);
});

test('pedal down during a pause is untimed; held through one, it has no duration %', () => {
  // n2 after a stop: expected at 1000, played at 2500.
  const times = [0, 500, 2500, 3000];
  const during = analyseFollow(melody(4), rec(playAt(times), pedal(2000, 2900)), 1, OPTS,
    [mark('p0', true, 1000), mark('p1', false, 1500)]);
  assert.equal(during.pedals[0].restart, 'pause');
  assert.equal(during.pedals[0].deltaMs, undefined);
  near(during.pedals[0].heldMs, 900);

  const through = analyseFollow(melody(4), rec(playAt(times), pedal(500, 2900)), 1, OPTS,
    [mark('p0', true, 500), mark('p1', false, 1500)]);
  near(through.pedals[0].deltaMs, 0);
  near(through.pedals[0].heldMs, 2400, 'real ms, not the clock\'s');
  assert.equal(through.pedals[0].durationPct, undefined);
});

test('nothing completed: an empty report', () => {
  const a = analyseFollow(melody(3), rec(key(70, 0)), 1, OPTS);
  assert.deepEqual([a.notes.length, a.extras.length], [0, 0]);
});
