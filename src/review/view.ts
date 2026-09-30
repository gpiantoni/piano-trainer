import { OFFSET_MIN_NOTES, type Alignment } from '../engine/align.ts';
import type { CursorMap } from '../score/cursor.ts';
import type { PlayedNote, PlayedPedal } from '../types.ts';
import {
  DEFAULT_SETTINGS, colorFor, context, describe, describePedal, outside, panels, pedalColor, pitchName, summary,
  windowOf, type Layer, type Offset, type ReviewSettings,
} from './layers.ts';
import { DURATION_RANGES, TIMING_CRITERIA } from './palettes.ts';

// After a tempo run: colour the noteheads by the chosen layer, with a legend
// strip at the bottom, and show all numbers for a tapped note.

const TAP_REACH_PX = 28;

const LAYERS: [Layer, string][] = [
  ['notes', 'Notes'], ['duration', 'Duration'], ['velocity', 'Velocity'], ['pedal', 'Pedal'],
];

type Options = {
  score: HTMLElement;
  strip: HTMLElement;
  load: () => Partial<ReviewSettings>;
  save: (s: ReviewSettings) => void;
  realign: () => void;           // criterion (so match window) or re-center changed
  download: () => void;
};

const button = (label: string, pressed: boolean, onClick: () => void, title = '') => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-pressed', String(pressed));
  b.onclick = onClick;
  return b;
};

const segment = (label: string, ...buttons: HTMLButtonElement[]) => {
  const wrap = document.createElement('span');
  wrap.className = 'opt';
  if (label) wrap.append(Object.assign(document.createElement('span'), { className: 'opt-label', textContent: label }));
  const seg = document.createElement('span');
  seg.className = 'seg small';
  seg.append(...buttons);
  wrap.append(seg);
  return wrap;
};

export class ReviewView {
  settings: ReviewSettings;
  alignment: Alignment | undefined;
  private speed = 1;
  private offset: Offset = { ms: undefined, notes: 0 };
  private noteEls = new Map<string, Element>();
  private cursorMap: CursorMap | undefined;
  private byNoteId = new Map<string, PlayedNote>();
  private pedalEls = new Map<string, Element>();
  // A sign's id -> the span it ends (*) and the one it starts (Ped.); a change sign does both.
  private byPedalId = new Map<string, { ends?: PlayedPedal; starts?: PlayedPedal }>();
  private markers: HTMLElement[] = [];
  private popover = Object.assign(document.createElement('div'), { className: 'popover', hidden: true });
  private opts: Options;

  constructor(opts: Options) {
    this.opts = opts;
    // From before Notes and Timing were one layer, and the criterion replaced the match window.
    const saved: Record<string, unknown> = { ...opts.load() };
    if (saved.layer === 'timing') saved.layer = 'notes';
    delete saved.maxOffsetBeats;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<ReviewSettings>) };
    if (!TIMING_CRITERIA.some((t) => t.within === this.settings.within)) this.settings.within = DEFAULT_SETTINGS.within;
    opts.score.addEventListener('click', (e) => this.onTap(e));
    document.addEventListener('click', (e) => {
      if (!opts.score.contains(e.target as Node)) this.popover.hidden = true;
    });
    // The strip wraps to more rows on narrow screens and in the Pedal layer:
    // keep the end of the score scrollable above it, whatever its height.
    new ResizeObserver(() => document.body.style.setProperty('--strip-h', `${opts.strip.offsetHeight}px`)).observe(opts.strip);
  }

  get active() { return !!this.alignment; }
  // × beat: how far off a key may be and still count as that note.
  get window() { return windowOf(this.settings); }

  show(alignment: Alignment, speed: number, offset: Offset) {
    this.alignment = alignment;
    this.speed = speed;
    this.offset = offset;
    this.byNoteId = new Map(alignment.notes.flatMap((n) => [n.expected.id, ...n.expected.tiedIds].map((id) => [id, n])));
    this.byPedalId = new Map();
    const sign = (id: string) => this.byPedalId.get(id) ?? this.byPedalId.set(id, {}).get(id)!;
    for (const p of alignment.pedals) {
      sign(p.mark.id).starts = p;
      if (p.end) sign(p.end.id).ends = p;
    }
    this.render();
  }

  clear() {
    this.alignment = undefined;
    this.byNoteId.clear();
    this.byPedalId.clear();
    this.popover.hidden = true;
    this.render();
  }

  // After every re-layout: new SVG elements, new positions.
  attach(noteEls: Map<string, Element>, cursorMap: CursorMap | undefined) {
    this.noteEls = noteEls;
    this.pedalEls = new Map([...this.opts.score.querySelectorAll('g.pedal')].map((el) => [el.id, el]));
    this.cursorMap = cursorMap;
    this.opts.score.append(this.popover);
    this.popover.hidden = true;
    this.paint();
  }

  private set(patch: Partial<ReviewSettings>) {
    const realign = ('within' in patch && patch.within !== this.settings.within)
      || ('recenter' in patch && patch.recenter !== this.settings.recenter);
    this.settings = { ...this.settings, ...patch };
    this.opts.save(this.settings);
    if (realign) this.opts.realign();
    else this.render();
  }

  private render() {
    this.paint();
    this.renderStrip();
  }

  // The Pedal layer only exists where the score has pedal signs; a saved
  // choice of it shows the Notes layer elsewhere, without being forgotten.
  private get hasPedal() { return !!this.alignment?.pedals.length; }
  private get shown(): ReviewSettings {
    return this.settings.layer === 'pedal' && !this.hasPedal ? { ...this.settings, layer: 'notes' } : this.settings;
  }

  private paint() {
    const a = this.alignment;
    const s = this.shown;
    const c = a && context(a, s, this.speed, this.offset);
    for (const [id, el] of this.noteEls) {
      const n = this.byNoteId.get(id);
      // Pedal: the signs carry the colour, the notes stay black.
      const on = !!(a && n) && s.layer !== 'pedal';
      el.classList.toggle('review', on);
      // Reviewing, but not in this run's report: after an early Stop.
      el.classList.toggle('unreviewed', !!a && !n);
      el.classList.toggle('pedal', on && s.layer === 'duration' && !!n!.pedal);
      if (on) (el as HTMLElement).style.setProperty('--note', colorFor(n!, s, c!));
      else (el as HTMLElement).style.removeProperty('--note');
    }
    for (const [id, el] of this.pedalEls) {
      const ps = this.byPedalId.get(id);
      const on = !!(a && ps) && s.layer === 'pedal';
      el.classList.toggle('review', on);
      // A change sign: coloured by the pedal going down again.
      if (on) {
        const color = ps!.starts ? pedalColor(ps!.starts, 'down', s, c!) : pedalColor(ps!.ends!, 'up', s, c!);
        (el as HTMLElement).style.setProperty('--note', color);
      }
      else (el as HTMLElement).style.removeProperty('--note');
    }

    for (const m of this.markers) m.remove();
    this.markers = [];
    if (!a || !this.cursorMap) return;
    if (s.layer === 'pedal') {
      for (const x of a.pedalExtras) {
        const pos = this.cursorMap.position(Math.max(0, x.atMs * this.speed));
        if (!pos) continue;
        const held = x.heldMs === undefined ? 'still down' : `held ${x.heldMs.toFixed(0)} ms`;
        this.addMarker('extra pedal', `pedal down · not in the score · ${held}`, pos.x, pos.bottom, 'below');
      }
      return;
    }
    if (s.layer !== 'notes') return;
    // Outside the criterion: a red arrow beside the notehead, pointing the way it was off.
    const base = this.opts.score.getBoundingClientRect();
    for (const n of a.notes) {
      const o = outside(n, s, c!);
      const head = o && this.noteEls.get(n.expected.id);
      if (!head) continue;
      const r = (head.querySelector('.notehead') ?? head).getBoundingClientRect();
      const m = document.createElement('span');
      m.className = `off ${o}`;
      m.textContent = o === 'early' ? '◂' : '▸';
      const x = o === 'early' ? r.left - base.left : r.right - base.left;
      m.style.transform = `translate(${x}px, ${r.top - base.top + r.height / 2}px)`;
      this.opts.score.append(m);
      this.markers.push(m);
    }
    for (const x of a.extras) {
      if (x.wrongFor) continue;
      const pos = this.cursorMap.position(Math.max(0, x.onsetMs * this.speed));
      if (!pos) continue;
      this.addMarker(`extra ${pitchName(x.pitch)}`, `${pitchName(x.pitch)} · not in the score · vel ${x.velocity}`, pos.x, pos.top);
    }
  }

  // A red × on the score: above the staves for a key, below for the pedal.
  private addMarker(title: string, text: string, x: number, y: number, extra = '') {
    const m = document.createElement('button');
    m.className = `extra ${extra}`.trim();
    m.textContent = '×';
    m.title = title;
    m.style.transform = `translate(${x}px, ${y}px)`;
    m.onclick = (e) => {
      e.stopPropagation();
      this.showPopover(text, x, y);
    };
    this.opts.score.append(m);
    this.markers.push(m);
  }

  private renderStrip() {
    const strip = this.opts.strip;
    const a = this.alignment;
    strip.hidden = !a;
    document.body.classList.toggle('reviewing', !!a);
    if (!a) { strip.replaceChildren(); return; }
    const s = this.shown;
    const c = context(a, s, this.speed, this.offset);

    const canRecenter = this.offset.ms !== undefined;
    const recenterOpt = segment('', button('Re-center', s.recenter, () => this.set({ recenter: !s.recenter }),
      canRecenter
        ? "Centre the match window and timing's zero on this run's own median offset, so a consistent lag or rush reads as on time"
        : `Needs ≥ ${OFFSET_MIN_NOTES} timed notes (this run has ${this.offset.notes})`));
    recenterOpt.classList.add('push-right');
    (recenterOpt.querySelector('button') as HTMLButtonElement).disabled = !canRecenter;

    const top = document.createElement('div');
    top.className = 'strip-row';
    top.append(
      segment('', ...LAYERS.filter(([id]) => id !== 'pedal' || this.hasPedal)
        .map(([id, label]) => button(label, s.layer === id, () => this.set({ layer: id })))),
      Object.assign(document.createElement('span'), { className: 'summary', textContent: summary(a, s, c) }),
      recenterOpt,
      Object.assign(button('Save run', false, () => this.opts.download(), 'Download this run as JSON'), { className: 'save' }),
    );

    const bottom = document.createElement('div');
    bottom.className = 'strip-row';
    for (const { legend: lg, rows } of panels(a, s, c)) {
      const wrap = document.createElement('div');
      wrap.className = 'ramp-wrap';
      wrap.classList.toggle('tall', lg.ticks.some((t) => t.label.includes('\n')));

      for (const row of rows) {
        const dist = document.createElement('div');
        dist.className = 'dist';
        if (row.label) dist.dataset.label = row.label;
        for (const x of row.xs) {
          const tick = document.createElement('i');
          tick.style.left = `${x * 100}%`;
          dist.append(tick);
        }
        wrap.append(dist);
      }

      const bar = document.createElement('div');
      bar.className = 'ramp';
      bar.style.setProperty('--ramp', lg.gradient);
      for (const at of lg.marks ?? []) {
        const mark = document.createElement('b');
        mark.className = 'crit';
        mark.style.left = `${at * 100}%`;
        bar.append(mark);
      }
      for (const t of lg.ticks) {
        const tick = document.createElement('span');
        tick.style.left = `${t.at * 100}%`;
        tick.textContent = t.label;
        bar.append(tick);
      }
      wrap.append(bar);
      bottom.append(wrap);
    }

    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const criterion = segment('within ±', ...TIMING_CRITERIA.map(({ within, window }) =>
      button(pct(within), s.within === within, () => this.set({ within }),
        `Timing criterion, as % of a beat: further off gets a red arrow. Colours and match window reach ±${pct(window)}`)));
    const durationRange = segment('range 0–', ...DURATION_RANGES.map((r) =>
      button(`${r} %`, s.durationMax === r, () => this.set({ durationMax: r }))));
    switch (s.layer) {
      case 'notes':
        bottom.append(
          criterion,
          segment('', button('log', s.timingLog, () => this.set({ timingLog: !s.timingLog }), 'Logarithmic: small and large offsets both visible')),
          Object.assign(document.createElement('span'), {
            className: 'key-legend',
            innerHTML: `<b class="k-arrow">◂ ▸</b> outside ±${pct(s.within)} <i class="k unmoved"></i>missed <b class="k-x">×</b> extra key`,
          }),
        );
        break;
      case 'pedal':
        bottom.append(criterion, durationRange, Object.assign(document.createElement('span'), {
          className: 'key-legend', innerHTML: '<i class="k unmoved"></i>pedal didn\'t go down <b class="k-x">×</b> extra pedal',
        }));
        break;
      case 'duration':
        bottom.append(durationRange,
          Object.assign(document.createElement('span'), { className: 'key-legend', innerHTML: '<i class="k ring"></i>pedal down' }));
        break;
      case 'velocity':
        bottom.append(segment('range', button('0–100', !s.velocityFit, () => this.set({ velocityFit: false })),
          button('fit to run', s.velocityFit, () => this.set({ velocityFit: true }))));
        break;
    }
    strip.replaceChildren(top, bottom);
  }

  // Fingers are wider than noteheads: take the nearest notehead within reach.
  // In the Pedal layer, the pedal signs instead of the notes.
  private onTap(e: MouseEvent) {
    if (!this.alignment) return;
    const c = context(this.alignment, this.shown, this.speed, this.offset);
    const pedal = this.shown.layer === 'pedal';
    let best: { text: () => string; r: DOMRect; d: number } | undefined;
    const consider = (el: Element, text: () => string) => {
      const r = (el.querySelector('.notehead') ?? el).getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (d < TAP_REACH_PX && (!best || d < best.d)) best = { text, r, d };
    };
    if (pedal) {
      for (const [id, el] of this.pedalEls) {
        const ps = this.byPedalId.get(id);
        if (ps) consider(el, () => describePedal(ps.ends, ps.starts, c));
      }
    } else {
      for (const [id, el] of this.noteEls) {
        const n = this.byNoteId.get(id);
        if (n) consider(el, () => describe(n, this.shown, c));
      }
    }
    if (!best) { this.popover.hidden = true; return; }
    const { text, r } = best;
    const base = this.opts.score.getBoundingClientRect();
    this.showPopover(text(), r.left - base.left + r.width / 2, r.top - base.top);
  }

  private showPopover(text: string, x: number, y: number) {
    const p = this.popover;
    p.textContent = text;
    p.hidden = false;
    const width = this.opts.score.clientWidth;
    const w = Math.min(p.offsetWidth, width - 16);
    p.style.left = `${Math.max(8, Math.min(width - w - 8, x - w / 2))}px`;
    p.style.top = `${Math.max(0, y - p.offsetHeight - 10)}px`;
  }
}
