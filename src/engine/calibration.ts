// Latency calibration: tap along with clicks; the median offset between each
// heard click and the key registered for it is the latency of the whole chain
// (tablet audio out + your ear-to-finger habit + USB MIDI in).

export const CALIBRATION = { bpm: 90, lead: 4, measured: 8 };

export type LatencyEstimate = { latencyMs: number; taps: number; spreadMs: number };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// clicks: times the measured clicks were heard; taps: key-down times (same clock).
export function estimateLatency(clicks: number[], taps: number[]): LatencyEstimate | undefined {
  if (clicks.length < 2) return undefined;
  const half = (clicks[1] - clicks[0]) / 2;
  const offsets: number[] = [];
  for (const c of clicks) {
    const near = taps.filter((t) => Math.abs(t - c) < half);
    if (near.length === 0) continue;
    offsets.push(near.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a)) - c);
  }
  if (offsets.length < Math.ceil(clicks.length / 2)) return undefined;   // too few taps to trust
  const latencyMs = median(offsets);
  const spreadMs = median(offsets.map((o) => Math.abs(o - latencyMs)));
  return { latencyMs: Math.round(latencyMs), taps: offsets.length, spreadMs: Math.round(spreadMs) };
}
