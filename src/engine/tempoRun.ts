import type { Click } from './metronome.ts';
import type { ScoreTiming } from '../score/timeline.ts';
import { playWindow, type PlayWindow } from '../score/section.ts';
import type { NoteEvent } from '../types.ts';

// One tempo-mode run: the clock, the clicks it needs, and the raw recording.
// Real time is performance.now() ms; score time is ms at 1.0×.
// score time = (real − t0) × speed. t0 is when score time 0 would be, even
// when the run plays a section that starts later (see score/section.ts).

export type RunPhase = 'countIn' | 'playing' | 'finished';

const LEAD_MS = 300;   // time for the audio to start before the first click

export class TempoRun {
  readonly t0: number;
  readonly clicks: Click[];
  readonly endScoreMs: number;
  readonly recording: NoteEvent[] = [];   // t relative to t0 (real ms), latency removed
  readonly timing: ScoreTiming;
  readonly speed: number;
  readonly latencyMs: number;
  readonly window: PlayWindow;
  stoppedAt: number | undefined;

  constructor(timing: ScoreTiming, speed: number, latencyMs = 0, window = playWindow(timing), now = performance.now()) {
    this.timing = timing;
    this.speed = speed;
    this.latencyMs = latencyMs;
    this.window = window;
    const firstClick = Math.min(window.startMs, window.countIn[0]?.t ?? window.startMs);
    this.t0 = now + LEAD_MS - firstClick / speed;
    const beats = timing.beats.filter((b) => b.t >= window.startMs - 1e-6 && b.t < window.endMs - 1e-6);
    const subs = timing.subdivisions.filter((t) => t >= window.startMs - 1e-6 && t < window.endMs - 1e-6);
    this.clicks = [
      ...window.countIn.map((c) => ({ at: this.realAt(c.t), accent: c.accent, always: true, sub: c.sub })),
      ...beats.map((b) => ({ at: this.realAt(b.t), accent: b.downbeat, always: false })),
      ...subs.map((t) => ({ at: this.realAt(t), accent: false, always: false, sub: true })),
    ];
    const lastBeat = beats.at(-1) ?? timing.beats.at(-1), prevBeat = beats.at(-2) ?? timing.beats.at(-2);
    const beatMs = lastBeat && prevBeat ? lastBeat.t - prevBeat.t : 500;
    this.endScoreMs = window.endMs + beatMs;
  }

  realAt(scoreMs: number) { return this.t0 + scoreMs / this.speed; }
  scoreTime(now = performance.now()) { return (now - this.t0) * this.speed; }

  phase(now = performance.now()): RunPhase {
    if (this.stoppedAt !== undefined) return 'finished';
    const t = this.scoreTime(now);
    return t < this.window.startMs ? 'countIn' : t > this.endScoreMs ? 'finished' : 'playing';
  }

  // Count-in beat number, counted up ("1 · 2 · 3") to match how a player
  // counts tempo aloud. A number stays on screen for the beat *after* its
  // click sounds, and "1" also covers the lead-in before the first click.
  countInNumber(now = performance.now()) {
    const beats = this.window.countIn.filter((c) => !c.sub);
    const sounded = beats.length - beats.filter((c) => this.realAt(c.t) > now).length;
    return Math.max(sounded, 1);
  }

  record(ev: NoteEvent) {
    if (this.stoppedAt !== undefined) return;
    this.recording.push({ ...ev, t: ev.t - this.latencyMs - this.t0 });
  }

  stop(now = performance.now()) {
    this.stoppedAt ??= now;
  }
}
