import type { NoteEvent } from '../types.ts';

// Starting a run from the piano: the first chord asked for, every key of it
// down at once and no other key, does what Start or Restart would. Only keys
// struck since reset() count, so a chord still held from the run before must be
// struck again, as in wait mode. Pure: no DOM, no clock.

export class OpeningChord {
  private down = new Map<number, NoteEvent>();   // keys struck since reset, still down
  private pedal: NoteEvent | undefined;          // the sustain pedal going down, while it stays down

  // `chord`: the pitches of the opening chord. Once all of it is down, the
  // events it was made of, in order: its keys' presses (a re-struck key with its
  // latest) and the pedal if it is down, so a run can start with them as its
  // own. Undefined until then.
  handle(chord: readonly number[], ev: NoteEvent): NoteEvent[] | undefined {
    if (ev.type === 'pedal') { this.pedal = ev.down ? ev : undefined; return; }
    if (ev.type === 'off') { this.down.delete(ev.pitch); return; }
    this.down.set(ev.pitch, ev);
    const want = new Set(chord);   // a unison is one key
    if (want.size === 0 || this.down.size !== want.size || ![...want].every((p) => this.down.has(p))) return;
    const events = [...this.down.values(), ...(this.pedal ? [this.pedal] : [])].sort((a, b) => a.t - b.t);
    this.reset();
    return events;
  }

  reset() {
    this.down.clear();
    this.pedal = undefined;
  }
}
