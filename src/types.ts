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
};
