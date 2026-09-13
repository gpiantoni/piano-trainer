# piano-trainer

A practice app for my own MuseScore pieces: real notation on screen, a cursor
moving in tempo, notes turning green when played correctly, per-note timing and
duration feedback, saved practice history. Runs as a PWA on an Android tablet
with the digital piano connected by USB.

## Development

Plug the piano into the **laptop** (Chrome on Linux supports Web MIDI, and
`localhost` is a secure context, so no Android friction during development).

```bash
npm install
npm run dev      # http://localhost:5173
```

- `http://localhost:5173/spike.html` — the MIDI debugger. Lists inputs, logs every
  message with timestamps, shows which keys are down. Keep it; it is the first
  thing to check whenever input misbehaves.

- `http://localhost:5173/` — the score view. It lists every `*.musicxml` under
  `public/scores/` (copy them from `MuseScore4/Scores/export/`). The files are
  gitignored except `public-domain/`, and `scores/manifest.json` is generated from
  whatever is there, so the deployed build lists only the public-domain pieces.

  Practice is **wait mode**: the blue notes are the chord to play; it turns green
  and advances once every note in it is pressed, and a wrong key flashes red and
  does not advance. No piano at hand? In the dev console, `__play(67)` presses G4
  and `__practice().expected` lists the pitches it is waiting for.

Web MIDI requires a **secure context**: `localhost` or HTTPS — `file://` will not
work.

**Use Chrome.** The tablet leaves no choice (Firefox for Android has no Web MIDI,
Safari has none anywhere), and matching browsers on the laptop means any
difference you see between the two machines is a real one rather than a browser
quirk. Firefox desktop does support Web MIDI since 108, but only on `localhost`
unless you install its per-site permission add-on, so it is usable for local
development and not for the deployed build.

## Stack

- Vite + TypeScript, vanilla DOM
- [Verovio](https://www.verovio.org/) — MusicXML engraving **and** the millisecond
  timemap that links each rendered note to its expected time
- Web MIDI API for input, Web Audio for the metronome
- IndexedDB (`idb`) for the score library and session history

## Phases

| | Phase | Gate |
|---|---|---|
| 0 | Toolchain + skeleton | dev server runs |
| 1 | MIDI works in the browser | laptop logs NOTE ON from the piano |
| 2 | MIDI works on the tablet | same, over HTTPS, on the real device |
| 3 | Show the score | a piece renders legibly on the tablet |
| 4 | Timeline + cursor + metronome | cursor on the right note at every downbeat |
| 5 | Compare: right notes (wait mode) | full piece playable, green/red |
| 6 | Add the clock: early/late grading (Strict / Normal / Relaxed, % of a beat) | Minuet on Normal: +120 ms reads as late |
| 7 | Duration + sustain pedal | over-held flagged, pedal-aware |
| 7b | Loudness (velocity), measured only | soft vs loud visible, never graded |
| 8 | Summary + saved sessions | trend across runs, JSON export |
| 9 | PWA on the tablet | offline, home-screen icon |
| 10 | Loops, one-hand, tempo ramp, import | — |

Full plan: `~/.claude/plans/i-have-a-midi-shimmering-candy.md`
