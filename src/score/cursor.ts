import type { ScoreTiming } from './timeline.ts';

// Score time -> position on the wrapped page. Control points come from the
// rendered SVG (where notes and rests actually are), so the cursor follows any
// layout verovio produced. Rebuild after every re-layout (zoom, resize).

export type SystemBox = { el: Element; top: number; bottom: number; left: number; right: number };
type Point = { t: number; system: number; x: number; lineEnd?: boolean };
export type CursorPos = { system: number; x: number; top: number; bottom: number };

type Box = { left: number; right: number; top: number; bottom: number };

export class CursorMap {
  readonly systems: SystemBox[] = [];
  private points: Point[] = [];

  constructor(container: HTMLElement, timing: ScoreTiming) {
    const base = container.getBoundingClientRect();
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top };
    };

    const systemIndex = new Map<Element, number>();
    for (const el of container.querySelectorAll('g.system')) {
      // Vertical extent of the staves only, not slurs or dynamics above/below.
      const staves = [...el.querySelector('g.measure')?.querySelectorAll(':scope > g.staff') ?? []].map(box);
      const whole = box(el);
      systemIndex.set(el, this.systems.length);
      this.systems.push({
        el,
        top: staves.length ? Math.min(...staves.map((s) => s.top)) : whole.top,
        bottom: staves.length ? Math.max(...staves.map((s) => s.bottom)) : whole.bottom,
        left: whole.left,
        right: whole.right,
      });
    }
    const systemOf = (el: Element) => systemIndex.get(el.closest('g.system')!) ?? -1;

    const byId = (id: string) => document.getElementById(id);
    const onsetTimes = new Set<number>();

    // A note or rest at each onset. Whole-bar rests are centred in the bar, which
    // would make the cursor jump ahead; the bar start stands in for them below.
    for (const onset of timing.onsets) {
      const els = onset.ids.map(byId).filter((el): el is HTMLElement =>
        !!el && container.contains(el) && !el.matches('.mRest, .multiRest'));
      if (els.length === 0) continue;
      const system = systemOf(els[0]);
      const x = Math.min(...els.filter((el) => systemOf(el) === system).map((el) => box(el).left));
      this.points.push({ t: onset.t, system, x });
      onsetTimes.add(Math.round(onset.t));   // timemap ms are integers; bar starts are not
    }

    timing.measures.forEach((m, i) => {
      const el = byId(m.id);
      if (!el || !container.contains(el)) return;
      const system = systemOf(el);
      const b = box(el);
      if (!onsetTimes.has(Math.round(m.startMs))) {
        // First bar of a line: start after the clef/key/time signature.
        const sigs = [...el.querySelectorAll('g.clef, g.keySig, g.meterSig')].map((s) => box(s).right);
        this.points.push({ t: Math.round(m.startMs), system, x: sigs.length ? Math.max(...sigs) + 4 : b.left + 4 });
      }
      // Last bar of a line: run to its barline before jumping to the next line.
      const next = timing.measures[i + 1] && byId(timing.measures[i + 1].id);
      if (!next || systemOf(next) !== system) {
        const barlines = [...el.querySelectorAll(':scope > g.barLine')].map((l) => box(l).right);
        this.points.push({ t: Math.round(m.endMs), system, x: barlines.length ? Math.max(...barlines) : b.right, lineEnd: true });
      }
    });

    // A line ends no later than the next line starts (bar times are interpolated,
    // onsets are rounded: a 1 ms disagreement must not send the cursor back up).
    for (const p of this.points) {
      if (!p.lineEnd) continue;
      const nextLine = this.points.filter((q) => q.system > p.system).reduce((m, q) => Math.min(m, q.t), Infinity);
      p.t = Math.min(p.t, nextLine);
    }
    // Same time: the end of one line comes before the start of the next.
    this.points.sort((a, b) => a.t - b.t || Number(!!b.lineEnd) - Number(!!a.lineEnd));
  }

  position(t: number): CursorPos | undefined {
    const pts = this.points;
    if (pts.length === 0) return undefined;
    let lo = 0, hi = pts.length - 1, i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const a = pts[i], b = pts[i + 1];
    let x = a.x;
    if (b && b.system === a.system && b.t > a.t && t > a.t) {
      x = a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
    }
    const sys = this.systems[a.system];
    return sys && { system: a.system, x, top: sys.top, bottom: sys.bottom };
  }
}
