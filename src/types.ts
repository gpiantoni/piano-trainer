export type NoteEvent = {
  type: 'on' | 'off';
  pitch: number;      // MIDI note number, 60 = middle C
  velocity: number;
  t: number;          // ms, performance.now() timebase (MIDIMessageEvent.timeStamp)
};

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

export type Staff = 1 | 2;   // 1 = right hand (upper staff), 2 = left hand

export type Hands = 'both' | 'right' | 'left';
