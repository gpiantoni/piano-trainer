import { OFFSET_MIN_NOTES, type Alignment } from '../engine/align.ts';
import type { CursorMap } from '../score/cursor.ts';
import type { PlayedNote } from '../types.ts';
import {
  DEFAULT_SETTINGS, colorFor, context, describe, distribution, legend, pitchName, summary,
  type Layer, type Offset, type ReviewSettings,
} from './layers.ts';
import { DURATION_RANGES, MATCH_WINDOWS } from './palettes.ts';

// After a tempo run: colour the noteheads by the chosen layer, with a legend
// strip at the bottom, and show all numbers for a tapped note.

const TAP_REACH_PX = 28;

const LAYERS: [Layer, string][] = [['notes', 'Notes'], ['timing', 'Timing'], ['duration', 'Duration'], ['velocity', 'Velocity']];

type Options = {
  score: HTMLElement;
  strip: HTMLElement;
  load: () => Partial<ReviewSettings>;
  save: (s: ReviewSettings) => void;
  realign: () => void;           // match window or re-center changed
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
  private markers: HTMLElement[] = [];
  private popover = Object.assign(document.createElement('div'), { className: 'popover', hidden: true });
  private opts: Options;

  constructor(opts: Options) {
    this.opts = opts;
    this.settings = { ...DEFAULT_SETTINGS, ...opts.load() };
    // Saved from before the current steps: back to the default.
    if (!MATCH_WINDOWS.includes(this.settings.maxOffsetBeats)) this.settings.maxOffsetBeats = DEFAULT_SETTINGS.maxOffsetBeats;
    opts.score.addEventListener('click', (e) => this.onTap(e));
    document.addEventListener('click', (e) => {
      if (!opts.score.contains(e.target as Node)) this.popover.hidden = true;
    });
  }

  get active() { return !!this.alignment; }

  show(alignment: Alignment, speed: number, offset: Offset) {
    this.alignment = alignment;
    this.speed = speed;
    this.offset = offset;
    this.byNoteId = new Map(alignment.notes.flatMap((n) => [n.expected.id, ...n.expected.tiedIds].map((id) => [id, n])));
    this.render();
  }

  clear() {
    this.alignment = undefined;
    this.byNoteId.clear();
    this.popover.hidden = true;
    this.render();
  }

  // After every re-layout: new SVG elements, new positions.
  attach(noteEls: Map<string, Element>, cursorMap: CursorMap | undefined) {
    this.noteEls = noteEls;
    this.cursorMap = cursorMap;
    this.opts.score.append(this.popover);
    this.popover.hidden = true;
    this.paint();
  }

  private set(patch: Partial<ReviewSettings>) {
    const realign = ('maxOffsetBeats' in patch && patch.maxOffsetBeats !== this.settings.maxOffsetBeats)
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

  private paint() {
    const a = this.alignment;
    const c = a && context(a, this.settings, this.speed, this.offset);
    for (const [id, el] of this.noteEls) {
      const n = this.byNoteId.get(id);
      const on = !!(a && n);
      el.classList.toggle('review', on);
      // Reviewing, but not in this run's report: after an early Stop.
      el.classList.toggle('unreviewed', !!a && !n);
      el.classList.toggle('pedal', on && this.settings.layer === 'duration' && !!n!.pedal);
      if (on) (el as HTMLElement).style.setProperty('--note', colorFor(n!, this.settings, c!));
      else (el as HTMLElement).style.removeProperty('--note');
    }

    for (const m of this.markers) m.remove();
    this.markers = [];
    if (!a || this.settings.layer !== 'notes' || !this.cursorMap) return;
    for (const x of a.extras) {
      if (x.wrongFor) continue;
      const pos = this.cursorMap.position(Math.max(0, x.onsetMs * this.speed));
      if (!pos) continue;
      const m = document.createElement('button');
      m.className = 'extra';
      m.textContent = '×';
      m.title = `extra ${pitchName(x.pitch)}`;
      m.style.transform = `translate(${pos.x}px, ${pos.top}px)`;
      m.onclick = (e) => {
        e.stopPropagation();
        this.showPopover(`${pitchName(x.pitch)} · not in the score · vel ${x.velocity}`, pos.x, pos.top);
      };
      this.opts.score.append(m);
      this.markers.push(m);
    }
  }

  private renderStrip() {
    const strip = this.opts.strip;
    const a = this.alignment;
    strip.hidden = !a;
    document.body.classList.toggle('reviewing', !!a);
    if (!a) { strip.replaceChildren(); return; }
    const s = this.settings;
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
      segment('', ...LAYERS.map(([id, label]) => button(label, s.layer === id, () => this.set({ layer: id })))),
      Object.assign(document.createElement('span'), { className: 'summary', textContent: summary(a, s, c) }),
      recenterOpt,
      Object.assign(button('Save run', false, () => this.opts.download(), 'Download this run as JSON'), { className: 'save' }),
    );

    const bottom = document.createElement('div');
    bottom.className = 'strip-row';
    const lg = legend(s, c);
    if (lg) {
      const wrap = document.createElement('div');
      wrap.className = 'ramp-wrap';
      wrap.classList.toggle('tall', lg.ticks.some((t) => t.label.includes('\n')));

      const dist = document.createElement('div');
      dist.className = 'dist';
      for (const x of distribution(a, s, c)) {
        const tick = document.createElement('i');
        tick.style.left = `${x * 100}%`;
        dist.append(tick);
      }
      wrap.append(dist);

      const bar = document.createElement('div');
      bar.className = 'ramp';
      bar.style.setProperty('--ramp', lg.gradient);
      for (const t of lg.ticks) {
        const tick = document.createElement('span');
        tick.style.left = `${t.at * 100}%`;
        tick.textContent = t.label;
        bar.append(tick);
      }
      wrap.append(bar);
      bottom.append(wrap);
    }

    const matchWindow = segment('match window ±', ...MATCH_WINDOWS.map((w) =>
      button(`${Math.round(w * 100)} %`, s.maxOffsetBeats === w, () => this.set({ maxOffsetBeats: w }),
        'How far off a key may be and still count as that note, as % of a beat; also the timing colour range')));
    switch (s.layer) {
      case 'notes':
        bottom.append(
          matchWindow,
          Object.assign(document.createElement('span'), {
            className: 'key-legend',
            innerHTML: '<i class="k played"></i>played <i class="k missed"></i>missed <b class="k-x">×</b> extra key',
          }),
        );
        break;
      case 'timing':
        bottom.append(
          matchWindow,
          segment('', button('log', s.timingLog, () => this.set({ timingLog: !s.timingLog }), 'Logarithmic: small and large offsets both visible')),
        );
        break;
      case 'duration':
        bottom.append(segment('range 0–', ...DURATION_RANGES.map((r) => button(`${r} %`, s.durationMax === r, () => this.set({ durationMax: r })))),
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
  private onTap(e: MouseEvent) {
    if (!this.alignment) return;
    let best: { n: PlayedNote; r: DOMRect; d: number } | undefined;
    for (const [id, el] of this.noteEls) {
      const n = this.byNoteId.get(id);
      if (!n) continue;
      const r = (el.querySelector('.notehead') ?? el).getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (d < TAP_REACH_PX && (!best || d < best.d)) best = { n, r, d };
    }
    if (!best) { this.popover.hidden = true; return; }
    const base = this.opts.score.getBoundingClientRect();
    const c = context(this.alignment, this.settings, this.speed, this.offset);
    this.showPopover(describe(best.n, c), best.r.left - base.left + best.r.width / 2, best.r.top - base.top);
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
