import type { Click } from './metronome.ts';
import type { ScoreTiming } from '../score/timeline.ts';
import type { NoteEvent } from '../types.ts';

// One tempo-mode run: the clock, the clicks it needs, and the raw recording.
// Real time is performance.now() ms; score time is ms at 1.0×.
// score time = (real − t0) × speed.

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
  stoppedAt: number | undefined;

  constructor(timing: ScoreTiming, speed: number, latencyMs = 0, now = performance.now()) {
    this.timing = timing;
    this.speed = speed;
    this.latencyMs = latencyMs;
    const firstClick = timing.countIn[0]?.t ?? 0;
    this.t0 = now + LEAD_MS - Math.min(0, firstClick) / speed;
    this.clicks = [
      ...timing.countIn.map((c) => ({ at: this.realAt(c.t), accent: c.accent, always: true })),
      ...timing.beats.map((b) => ({ at: this.realAt(b.t), accent: b.downbeat, always: false })),
    ];
    const lastBeat = timing.beats.at(-1), prevBeat = timing.beats.at(-2);
    const beatMs = lastBeat && prevBeat ? lastBeat.t - prevBeat.t : 500;
    this.endScoreMs = timing.endMs + beatMs;
  }

  realAt(scoreMs: number) { return this.t0 + scoreMs / this.speed; }
  scoreTime(now = performance.now()) { return (now - this.t0) * this.speed; }

  phase(now = performance.now()): RunPhase {
    if (this.stoppedAt !== undefined) return 'finished';
    const t = this.scoreTime(now);
    return t < 0 ? 'countIn' : t > this.endScoreMs ? 'finished' : 'playing';
  }

  // Count-in clicks still to come (for the "3 · 2 · 1" display).
  countInLeft(now = performance.now()) {
    return this.timing.countIn.filter((c) => this.realAt(c.t) > now).length;
  }

  record(ev: NoteEvent) {
    if (this.stoppedAt !== undefined) return;
    this.recording.push({ ...ev, t: ev.t - this.latencyMs - this.t0 });
  }

  stop(now = performance.now()) {
    this.stoppedAt ??= now;
  }
}
