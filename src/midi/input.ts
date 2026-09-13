import type { NoteEvent } from '../types.ts';

export type MidiStatus =
  | { kind: 'unsupported' }
  | { kind: 'denied'; message: string }
  | { kind: 'ready'; inputs: string[] };

// Listens to every connected input (and ones plugged in later). Note-on with
// velocity 0 is reported as 'off': many keyboards send only that form.
export async function listenMidi(
  onNote: (ev: NoteEvent) => void,
  onStatus: (s: MidiStatus) => void,
): Promise<void> {
  if (!navigator.requestMIDIAccess) return onStatus({ kind: 'unsupported' });

  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    return onStatus({ kind: 'denied', message: String(err) });
  }

  const onMessage = (e: MIDIMessageEvent) => {
    if (!e.data || e.data.length < 3) return;   // realtime/clock bytes are 1 byte
    const [status, pitch, velocity] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) onNote({ type: 'on', pitch, velocity, t: e.timeStamp });
    else if (cmd === 0x80 || cmd === 0x90) onNote({ type: 'off', pitch, velocity: 0, t: e.timeStamp });
  };

  const attach = () => {
    const inputs = [...access.inputs.values()];
    for (const input of inputs) input.onmidimessage = onMessage;
    onStatus({ kind: 'ready', inputs: inputs.filter((i) => i.state === 'connected').map((i) => i.name ?? 'MIDI input') });
  };
  access.onstatechange = attach;   // hot-plug
  attach();
}
