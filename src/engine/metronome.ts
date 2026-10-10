// Web Audio metronome with lookahead scheduling: a short timer schedules clicks
// a little ahead at exact AudioContext times. Clicks are never played straight
// from the timer; that drifts audibly.

export type Click = {
  at: number;          // performance.now() ms at which the click should be *heard*
  accent: boolean;
  always: boolean;     // count-in clicks sound even with the metronome switched off
  sub?: boolean;       // a subdivision between two beats, in its own sound
};

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const BELL_HZ = 1762.5;
const BELL = [
  { ratio: 1, amp: 1, decay: 0.35 },
  { ratio: 2.76, amp: 0.4, decay: 0.15 },
  { ratio: 5.4, amp: 0.2, decay: 0.08 },
];
const WOOD_HZ = 800;
const WOOD = [
  { ratio: 1, amp: 0.65, decay: 0.18 },
  { ratio: 2.48, amp: 0.2, decay: 0.07 },
];
const WOOD_PEAK = 0.9;
const SUB_PEAK = WOOD_PEAK * 10 ** (-1 / 20);   // 1 dB below the beat

export class Metronome {
  enabled = true;
  subdivide = false;   // click the subdivisions between beats too
  volume = 1;
  private ctx: AudioContext | undefined;
  private noise: AudioBuffer | undefined;
  private timer: number | undefined;
  private queue: Click[] = [];
  private next = 0;
  private sources: { nodes: AudioScheduledSourceNode[]; end: number }[] = [];
  private toAudio = (ms: number) => ms / 1000;

  // Must be called from a user gesture (tap) the first time: autoplay rules.
  async prepare(): Promise<void> {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.noise ??= whiteNoise(this.ctx, 0.5);
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
    for (const s of this.sources) for (const node of s.nodes) { try { node.stop(); } catch { /* already stopped */ } }
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

  // Downbeat: a bell, so bar lines stand out by timbre, not just pitch. Beats
  // are a wood block; the eighths a smaller, higher one, so they read as filling
  // in between rather than as beats of their own.
  private click(at: number, accent: boolean, sub = false) {
    if (accent && !sub) this.bell(at);
    else if (sub) this.wood(at, WOOD_HZ * 2, this.volume * SUB_PEAK, 0.6);
    else this.wood(at, WOOD_HZ, this.volume * WOOD_PEAK);
  }

  // Two inharmonic modes that drop slightly in pitch, as a struck block does,
  // plus a few ms of filtered noise for the knock of the stick. `size` scales
  // the ring: a smaller block dies away sooner.
  private wood(at: number, freq: number, peak: number, size = 1) {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = peak;
    out.connect(ctx.destination);
    const nodes: AudioScheduledSourceNode[] = [];
    let end = at;
    for (const m of WOOD) {
      const osc = ctx.createOscillator();
      const f = freq * m.ratio;
      osc.frequency.setValueAtTime(f * 1.04, at);
      osc.frequency.exponentialRampToValueAtTime(f, at + 0.012);
      osc.connect(envelope(ctx, at, m.amp, m.decay * size)).connect(out);
      osc.start(at);
      osc.stop(at + m.decay * size + 0.01);
      nodes.push(osc);
      end = Math.max(end, at + m.decay * size + 0.01);
    }
    const knock = ctx.createBufferSource();
    knock.buffer = this.noise!;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq * 4;
    knock.connect(band).connect(envelope(ctx, at, 0.5, 0.012, 0.001)).connect(out);
    knock.start(at, Math.random() * 0.4);
    knock.stop(at + 0.02);
    nodes.push(knock);
    this.sources.push({ nodes, end });
  }

  // Sine partials at inharmonic ratios, as in a small bell; the upper ones die
  // away faster, which is what makes it ring rather than buzz. The attack is as
  // sharp as the wood block's, so it marks the beat just as precisely.
  private bell(at: number) {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = this.volume / BELL.reduce((sum, p) => sum + p.amp, 0);
    out.connect(ctx.destination);
    const nodes: OscillatorNode[] = [];
    let end = at;
    for (const p of BELL) {
      const osc = ctx.createOscillator();
      osc.frequency.value = BELL_HZ * p.ratio;
      osc.connect(envelope(ctx, at, p.amp, p.decay)).connect(out);
      osc.start(at);
      osc.stop(at + p.decay + 0.01);
      nodes.push(osc);
      end = Math.max(end, at + p.decay + 0.01);
    }
    this.sources.push({ nodes, end });
  }
}

// A percussive gain: a sharp attack, then an exponential fall to silence.
function envelope(ctx: AudioContext, at: number, peak: number, decay: number, attack = 0.002): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  return gain;
}

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
