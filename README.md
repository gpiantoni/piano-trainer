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
npm test         # alignment, calibration, library and section tests (Node, no browser)
```

- `http://localhost:5173/spike.html` — the MIDI debugger. Lists inputs, logs every
  message with timestamps, shows which keys are down. Keep it; it is the first
  thing to check whenever input misbehaves.

- `http://localhost:5173/` — the score view. The picker has two groups:

  **On this device** — scores added with **Library**: **Add files…** (any
  `.musicxml`, `.xml` or `.mxl`) or **Link folder…** (Chrome, including Android),
  then **Rescan** after exporting again from MuseScore. Only new or changed files
  are read, and a file that no longer renders is reported and not saved. The
  files are copied into IndexedDB, so they play offline and without folder
  permission. A score removed from the folder is marked "not in folder" and never
  deleted automatically. To remove a score its linked folder still has, unlink the
  folder first. The library belongs to the origin, so `localhost` and the deployed
  site each have their own.

  **Built in** — every `*.musicxml` under `public/scores/`. The files are
  gitignored except `public-domain/`, and `scores/manifest.json` is generated from
  whatever is there, so the deployed build lists only the public-domain pieces.

  **Wait mode**: the score waits for the next chord; it turns green
  and advances once every note in it is pressed, and a wrong key flashes the
  expected notes red and does not advance.

  **Tempo mode**: pick a tempo (−/+ in steps of 5 bpm; shown as bpm · % of the
  score's tempo · one beat in ms, remembered per score), **Start** (or Space), one bar of count-in clicks,
  then play along with the cursor; 🔔 switches the metronome off after the
  count-in. Nothing is marked while you play. At the end (or **Stop**) the score
  shows the run in colour layers, switched in the strip at the bottom:
  **Notes** (played / missed / × extra key), **Timing** (blue early, green on
  time, amber to red late, as % of a beat or of the note), **Duration** (% of the
  written length held, amber short to deep purple long; blue ring = pedal down),
  **Velocity** (teal soft to navy loud, one strip row per hand) and, where the
  score has Ped. / * signs, **Pedal** (each Ped. to * read like a note: Ped.
  coloured on the timing scale by when the sustain pedal went down, * on the
  duration scale by how long it stayed down, as % of the written span; grey =
  it didn't go down, × = a pedal not in the score). Missed notes, the other hand and
  notes after an early **Stop** are grey. Tap a note for
  its numbers. These are measurements, not grades. **Save run** downloads the
  raw recording as JSON. **⏱** calibrates latency: tap along with 8 clicks once
  per device.

  **Bars** practises a section: tap the first bar, then the last (either order).
  The other bars go grey; wait mode starts at the first bar, and a tempo run
  counts in one bar before it and stops after the last. Remembered per score;
  **✕** goes back to the whole piece.

  **Both / Left / Right** picks the hand in either mode: the other staff greys
  out and is not asked for. **Full screen** hides the browser bars on the tablet.

  No piano at hand? In the dev console, `__play(67)` presses G4,
  `__practice().expected` lists what wait mode is waiting for, and
  `__replay(recording, speed)` shows a saved run's `recording` in review.

Web MIDI requires a **secure context**: `localhost` or HTTPS — `file://` will not
work.

**Use Chrome.** The tablet leaves no choice (Firefox for Android has no Web MIDI,
Safari has none anywhere), and matching browsers on the laptop means any
difference you see between the two machines is a real one rather than a browser
quirk. Firefox desktop does support Web MIDI since 108, but only on `localhost`
unless you install its per-site permission add-on, so it is usable for local
development and not for the deployed build.

## Exporting from MuseScore

```bash
scripts/export.sh "path/to/Song Name"   # .mscz extension optional
```

writes `Song Name.pdf`, `.mid` and `.musicxml` into `export/` next to the score
(the folder to link in **Library**), and prints the title, composer and tempo
(`scripts/mscz_info.py`). Needs `mscore` (MuseScore 4) and `python3`. With a
symlink in the score folder, `./export.sh "Song Name"` works there:

```bash
ln -s ~/Documents/piano-trainer/scripts/export.sh ~/Documents/MuseScore4/Scores/
```

The MusicXML has its **repeats unrolled** (`mscore --unroll-repeats`): voltas,
D.C., D.S. and codas are written out in playing order, so bar numbers run past
the printed ones. Verovio would play the repeats of a written-out score too, but
gives the second pass note ids it never draws, so the cursor and the review
colours have nothing to land on. The PDF and MIDI keep the repeats as written.

## Stack

- Vite + TypeScript, vanilla DOM
- [Verovio](https://www.verovio.org/) — MusicXML engraving **and** the millisecond
  timemap that links each rendered note to its expected time
- Web MIDI API for input, Web Audio for the metronome
- IndexedDB (`idb`) for the score library and session history

## Phases

| | Phase | Gate |
|---|---|---|
| 0 | Toolchain + skeleton ✅ | dev server runs |
| 1 | MIDI works in the browser ✅ | laptop logs NOTE ON from the piano |
| 2 | MIDI works on the tablet ✅ | same, over HTTPS, on the real device |
| 3 | Show the score ✅ | a piece renders legibly on the tablet |
| 4 | Cursor on wrapped lines + count-in + metronome ✅ | cursor on the right note at every downbeat |
| 5 | Wait mode, one-hand, full screen ✅ | full piece playable, green/red |
| 6 | Tempo run: play along and record (no live feedback) ✅ | onsets line up after latency calibration |
| 7 | Align recording to score (pure, tested) ✅ | late / missed / wrong key / staccato read correctly |
| 8 | Review in four colour layers: notes, timing, duration, velocity ✅ | measurements, not grades |
| 9 | Score library: add files / link a folder from the device ✅ | tablet imports a MuseScore export, rescan picks up changes |
| 10 | Play a section: some bars only ✅ | two taps pick the bars; count-in, run and review cover only them |
| 11 | Summary + saved sessions | trend across runs, backup export/import |
| 12 | PWA on the tablet | offline, home-screen icon, share a score to the app |
| 13 | Continuous loops, tempo ramp | — |

Full plan: `~/.claude/plans/i-have-a-midi-shimmering-candy.md`
