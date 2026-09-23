// Web Audio metronome with lookahead scheduling: a short timer schedules clicks
// a little ahead at exact AudioContext times. Clicks are never played straight
// from the timer; that drifts audibly.

export type Click = {
  at: number;          // performance.now() ms at which the click should be *heard*
  accent: boolean;
  always: boolean;     // count-in clicks sound even with the metronome switched off
  sub?: boolean;       // an "and": halfway between two beats, in its own sound
};

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const BEAT_HZ = 1175;
const BELL_HZ = BEAT_HZ * 1.5;
const BELL = [
  { ratio: 1, amp: 1, decay: 0.35 },
  { ratio: 2.76, amp: 0.4, decay: 0.15 },
  { ratio: 5.4, amp: 0.2, decay: 0.08 },
];

export class Metronome {
  enabled = true;
  subdivide = false;   // click the "and" halfway between beats too
  volume = 1;
  private ctx: AudioContext | undefined;
  private timer: number | undefined;
  private queue: Click[] = [];
  private next = 0;
  private sources: { oscs: OscillatorNode[]; end: number }[] = [];
  private toAudio = (ms: number) => ms / 1000;

  // Must be called from a user gesture (tap) the first time: autoplay rules.
  async prepare(): Promise<void> {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.syncClocks();
  }

  play(clicks: Click[]) {
    this.stop();
    this.queue = [...clicks].sort((a, b) => a.at - b.at);
    this.next = 0;
    this.syncClocks();
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.sources) for (const osc of s.oscs) { try { osc.stop(); } catch { /* already stopped */ } }
    this.sources = [];
    this.queue = [];
  }

  // AudioContext time and performance.now() are different clocks. The output
  // timestamp pairs them at one instant and accounts for the output latency the
  // browser knows about, so a click scheduled at toAudio(t) is heard at ~t.
  private syncClocks() {
    const ctx = this.ctx;
    if (!ctx) return;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime !== undefined) {
      const { contextTime, performanceTime } = ts;
      this.toAudio = (ms) => contextTime + (ms - performanceTime) / 1000;
    } else {
      const now = performance.now(), audio = ctx.currentTime - (ctx.outputLatency || 0);
      this.toAudio = (ms) => audio + (ms - now) / 1000;
    }
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    while (this.next < this.queue.length) {
      const click = this.queue[this.next];
      const at = this.toAudio(click.at);
      if (at > horizon) break;
      this.next++;
      const audible = click.always || this.enabled;
      if (at < ctx.currentTime - 0.01 || !audible || (click.sub && !this.subdivide)) continue;
      this.click(Math.max(at, ctx.currentTime), click.accent, click.sub);
    }
    this.sources = this.sources.filter((s) => s.end > ctx.currentTime);
    if (this.next >= this.queue.length && this.sources.length === 0) clearInterval(this.timer);
  }

  // Downbeat: a bell, so bar lines stand out by timbre, not just pitch. Beat and
  // "and" are short ticks a fifth apart (the same interval the bell sits above the
  // beat), stepping down in pitch and volume with their weight in the bar.
  private click(at: number, accent: boolean, sub = false) {
    if (accent && !sub) this.bell(at);
    else this.tick(at, sub ? BEAT_HZ / 1.5 : BEAT_HZ, this.volume * (sub ? 0.45 : 0.6));
  }

  private tick(at: number, freq: number, peak: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const decay = 0.05;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + decay + 0.01);
    this.sources.push({ oscs: [osc], end: at + decay + 0.01 });
  }

  // Sine partials at inharmonic ratios, as in a small bell; the upper ones die
  // away faster, which is what makes it ring rather than buzz. The attack is as
  // sharp as a tick's, so it marks the beat just as precisely.
  private bell(at: number) {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = this.volume / BELL.reduce((sum, p) => sum + p.amp, 0);
    out.connect(ctx.destination);
    const oscs: OscillatorNode[] = [];
    let end = at;
    for (const p of BELL) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = BELL_HZ * p.ratio;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(p.amp, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + p.decay);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + p.decay + 0.01);
      oscs.push(osc);
      end = Math.max(end, at + p.decay + 0.01);
    }
    this.sources.push({ oscs, end });
  }
}
