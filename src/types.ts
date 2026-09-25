export type KeyEvent = {
  type: 'on' | 'off';
  pitch: number;      // MIDI note number, 60 = middle C
  velocity: number;
  t: number;          // ms, performance.now() timebase (MIDIMessageEvent.timeStamp)
};

export type PedalEvent = { type: 'pedal'; down: boolean; t: number };   // sustain, CC 64

export type NoteEvent = KeyEvent | PedalEvent;

export type ExpectedEvent = {
  id: string;         // verovio xml:id == SVG element id of the (first) notehead
  tiedIds: string[];  // continuation noteheads of a tie: sounded by the same key press
  pitch: number;
  onMs: number;       // from the timemap, at 1.0x tempo
  offMs: number;      // end of the last tied note
  staff: Staff;
  beatMs: number;     // one beat (the meter's pulse) at this note, at 1.0x
  measure: number;    // 0-based bar index in performance order
};

// A pedal sign in the score: Ped. (down) or * (up). A change sign is both, up
// then down at the same time, sharing one id.
export type PedalMark = {
  id: string;         // verovio xml:id == SVG element id of the sign
  down: boolean;
  t: number;          // score ms at 1.0×
  beatMs: number;     // one beat at this mark, at 1.0×
};

export type Staff = 1 | 2;   // 1 = right hand (upper staff), 2 = left hand

export type Hands = 'both' | 'right' | 'left';

// One expected note after a tempo run: what actually happened. Measurements
// only, nothing here is a grade. Times are real ms at the practice speed,
// relative to the run's t0.
export type PlayedNote = {
  expected: ExpectedEvent;
  status: 'played' | 'missed';
  wrongPitch?: number;   // missed, and a nearby unmatched key suggests this was meant
  onsetMs?: number;      // key down
  deltaMs?: number;      // onsetMs − expected onset; negative = early
  deltaPct?: number;     // deltaMs as % of a beat
  heldMs?: number;       // key down → key up (the finger, not the sound)
  durationPct?: number;  // heldMs as % of the written duration
  velocity?: number;     // 1–127
  velocityPct?: number;  // velocity / 127 × 100
  pedal?: boolean;       // sustain pedal down at any time while the key was held
};

// A key press that matched no note in the score.
export type Extra = { pitch: number; onsetMs: number; velocity: number; wrongFor?: string };

// One pedal sign after a tempo run, like PlayedNote: when the pedal actually
// went down (or up), if it did within the match window.
export type PlayedPedal = {
  mark: PedalMark;
  atMs?: number;         // real ms from t0; undefined = missed
  deltaMs?: number;      // atMs − the sign's time; negative = early
};

// A pedal change that matched no sign in the score.
export type PedalExtra = { down: boolean; atMs: number };
