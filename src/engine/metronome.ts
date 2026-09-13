// Web Audio metronome with lookahead scheduling: a short timer schedules clicks
// a little ahead at exact AudioContext times. Clicks are never played straight
// from the timer; that drifts audibly.

export type Click = {
  at: number;          // performance.now() ms at which the click should be *heard*
  accent: boolean;
  always: boolean;     // count-in clicks sound even with the metronome switched off
};

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export class Metronome {
  enabled = true;
  volume = 0.5;
  private ctx: AudioContext | undefined;
  private timer: number | undefined;
  private queue: Click[] = [];
  private next = 0;
  private sources: { osc: OscillatorNode; end: number }[] = [];
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
    for (const s of this.sources) { try { s.osc.stop(); } catch { /* already stopped */ } }
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
      if (at < ctx.currentTime - 0.01 || !(click.always || this.enabled)) continue;
      this.click(Math.max(at, ctx.currentTime), click.accent);
    }
    this.sources = this.sources.filter((s) => s.end > ctx.currentTime);
    if (this.next >= this.queue.length && this.sources.length === 0) clearInterval(this.timer);
  }

  private click(at: number, accent: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = accent ? 1760 : 1175;
    const peak = this.volume * (accent ? 1 : 0.7);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
    this.sources.push({ osc, end: at + 0.06 });
  }
}
