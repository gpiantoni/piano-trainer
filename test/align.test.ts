import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align, keyPresses } from '../src/engine/align.ts';
import { estimateLatency } from '../src/engine/calibration.ts';
import type { ExpectedEvent, NoteEvent, Staff } from '../src/types.ts';

// A quarter-note melody at 120 BPM (beat = 500 ms), ids n0, n1, …
const BEAT = 500;
function score(pitches: number[], staff: Staff = 1, idPrefix = 'n', dur = BEAT): ExpectedEvent[] {
  return pitches.map((pitch, i) => ({
    id: `${idPrefix}${i}`, tiedIds: [], pitch, staff,
    onMs: i * BEAT, offMs: i * BEAT + dur, beatMs: BEAT, measure: Math.floor(i / 4),
  }));
}

// Play each note: onset shifted by `late` ms, held for `hold` of its length.
function perform(events: ExpectedEvent[], { speed = 1, late = 0, hold = 0.9, velocity = 60 } = {}): NoteEvent[] {
  return events.flatMap((e) => {
    const on = e.onMs / speed + late;
    return [
      { type: 'on' as const, pitch: e.pitch, velocity, t: on },
      { type: 'off' as const, pitch: e.pitch, velocity: 0, t: on + ((e.offMs - e.onMs) / speed) * hold },
    ];
  });
}

const byId = (notes: ReturnType<typeof align>['notes'], id: string) => notes.find((n) => n.expected.id === id)!;

test('an accurate performance: all played, near-zero timing, measured duration and velocity', () => {
  const s = score([60, 62, 64, 65]);
  const { notes, extras } = align(s, perform(s, { hold: 0.5, velocity: 127 }), 1);
  assert.equal(extras.length, 0);
  for (const n of notes) {
    assert.equal(n.status, 'played');
    assert.equal(n.deltaMs, 0);
    assert.equal(Math.round(n.durationPct!), 50);
    assert.equal(n.velocityPct, 100);
  }
});

test('late playing reads as positive % of a beat', () => {
  const s = score([60, 62, 64, 65]);
  const { notes } = align(s, perform(s, { late: 100 }), 1);
  assert.equal(notes[0].deltaMs, 100);
  assert.equal(notes[0].deltaPct, 20);
});

test('early playing reads as negative; note-value reference doubles % for eighths', () => {
  const s = score([60, 62], 1, 'n', BEAT / 2);   // eighth notes on each beat
  const beat = align(s, perform(s, { late: -50 }), 1);
  const note = align(s, perform(s, { late: -50 }), 1, { reference: 'note' });
  assert.equal(beat.notes[0].deltaPct, -10);
  assert.equal(note.notes[0].deltaPct, -20);
});

test('practice speed: deltas are in real ms and % of the slowed beat', () => {
  const s = score([60, 62, 64]);
  const { notes } = align(s, perform(s, { speed: 0.5, late: 100 }), 0.5);
  assert.equal(notes[1].deltaMs, 100);
  assert.equal(notes[1].deltaPct, 10);   // beat is 1000 ms at half speed
  assert.equal(Math.round(notes[1].durationPct!), 90);
});

test('a skipped note is missed and does not steal the next key', () => {
  const s = score([60, 60, 60, 60]);
  const rec = perform(s).filter((e) => !(e.type !== 'pedal' && e.t >= 500 && e.t < 1000));
  const { notes, extras } = align(s, rec, 1);
  assert.deepEqual(notes.map((n) => n.status), ['played', 'missed', 'played', 'played']);
  assert.equal(extras.length, 0);
});

test('repeated notes all rushed by 40 % of a beat stay matched in order', () => {
  const s = score([67, 67, 67, 67, 67]);
  const { notes, extras } = align(s, perform(s, { late: -200 }), 1);
  assert.equal(extras.length, 0);
  assert.deepEqual(notes.map((n) => Math.round(n.deltaPct!)), [-40, -40, -40, -40, -40]);
});

test('very late (beyond the window) is a miss plus an extra; a wider window matches it', () => {
  const s = score([60, 72]);
  const rec = perform(s).map((e) => (e.type !== 'pedal' && e.pitch === 72 ? { ...e, t: e.t + 700 } : e));
  const tight = align(s, rec, 1);
  assert.equal(byId(tight.notes, 'n1').status, 'missed');
  assert.equal(tight.extras.length, 1);
  const loose = align(s, rec, 1, { maxOffsetBeats: 2 });
  assert.equal(Math.round(byId(loose.notes, 'n1').deltaPct!), 140);
  assert.equal(loose.extras.length, 0);
});

test('a wrong key a semitone away: missed with wrongPitch, the key listed as extra for it', () => {
  const s = score([60, 64, 67]);
  const rec = perform(s).map((e) => (e.type !== 'pedal' && e.pitch === 64 ? { ...e, pitch: 63 } : e));
  const { notes, extras } = align(s, rec, 1);
  const n1 = byId(notes, 'n1');
  assert.equal(n1.status, 'missed');
  assert.equal(n1.wrongPitch, 63);
  assert.deepEqual(extras.map((x) => [x.pitch, x.wrongFor]), [[63, 'n1']]);
});

test('one hand selected: the other hand is aligned but not reported, and not playing it is fine', () => {
  const rh = score([72, 74, 76], 1, 'r');
  const lh = score([48, 50, 52], 2, 'l');
  const both = [...rh, ...lh].sort((a, b) => a.onMs - b.onMs);
  const onlyRight = align(both, perform(rh), 1, { hands: 'right' });
  assert.equal(onlyRight.notes.length, 3);
  assert.ok(onlyRight.notes.every((n) => n.status === 'played'));
  const bothPlayed = align(both, perform(both), 1, { hands: 'right' });
  assert.equal(bothPlayed.extras.length, 0);
});

test('stopped early: notes after the stop are not reported as missed', () => {
  const s = score([60, 62, 64, 65, 67, 69]);
  const rec = perform(s.slice(0, 3));
  const { notes } = align(s, rec, 1, { untilMs: 1200 });
  assert.deepEqual(notes.map((n) => n.status), ['played', 'played', 'played']);
});

test('staccato vs legato durations', () => {
  const s = score([60, 62, 64, 65]);
  const stacc = align(s, perform(s, { hold: 0.3 }), 1).notes.map((n) => Math.round(n.durationPct!));
  const leg = align(s, perform(s, { hold: 1.05 }), 1).notes.map((n) => Math.round(n.durationPct!));
  assert.deepEqual(stacc, [30, 30, 30, 30]);
  assert.deepEqual(leg, [105, 105, 105, 105]);
});

test('pedal: flagged while held, release still measured; re-press closes a held key', () => {
  const rec: NoteEvent[] = [
    { type: 'on', pitch: 60, velocity: 50, t: 0 },
    { type: 'pedal', down: true, t: 100 },
    { type: 'off', pitch: 60, velocity: 0, t: 200 },
    { type: 'pedal', down: false, t: 900 },
    { type: 'on', pitch: 62, velocity: 50, t: 1000 },
    { type: 'on', pitch: 62, velocity: 50, t: 1300 },   // no off in between
  ];
  const p = keyPresses(rec);
  assert.deepEqual(p.map((x) => [x.pitch, x.on, x.off, x.pedal]), [
    [60, 0, 200, true], [62, 1000, 1300, false], [62, 1300, undefined, false],
  ]);
});

test('latency: median offset of taps to clicks, ignoring a stray tap', () => {
  const clicks = [0, 667, 1333, 2000, 2667, 3333, 4000, 4667];
  const taps = [30, 700, 1360, 2031, 2690, 3370, 4025, 4700, 2300];
  const est = estimateLatency(clicks, taps)!;
  assert.ok(est.latencyMs >= 28 && est.latencyMs <= 34, String(est.latencyMs));
  assert.equal(est.taps, 8);
  assert.equal(estimateLatency(clicks, [30]), undefined);
});
