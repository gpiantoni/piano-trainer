# Plan: Follow mode

Handoff, 2026-10-25. Follow mode is implemented and on `main`, following the principle below. **Next: the manual test checklist on the piano.**

## What Follow is

A third practice mode between Wait and Tempo: **Wait · Follow · Tempo**.

While playing, Follow behaves exactly like Wait. The score waits for each chord, all of it held down at once. A wrong key flashes red and does not advance. Played notes turn green. There is no metronome and no count-in.

Nothing is timed while playing: the keys are only recorded. When the run ends, the analysis lays a clock at the run's bpm over the recording, and the score shows the same review as Tempo: the Notes/Timing, Duration, Velocity and Pedal layers, the tap popover and Save run.

## The principle (decided 2026-10-25)

**One tempo, agreed before playing. No retrofitting.**

> "There should be only one tempo which I agree beforehand, no retrofitting. It doesn't make sense to say: I wanted to play it at 50 bpm but I ended up playing it faster and it's good. Even if I don't play with a metronome, there should be one tempo I follow."

So the review never adapts the clock to how the run was played: not its tempo, and not its starting point within a stretch. The only things that move the clock are the first chord and stops.

**A stop is late by definition.** The chord after a stop is timed against the clock that was running, so it reads late. Then the clock restarts from it.

## Rules (decided)

| Thing | Rule |
|---|---|
| Tempo | The practice bpm set with −/+ (`speed`, per-score memory, shared with Tempo), **taken when the run starts** (its first key) and fixed for that run. The review is timed at that bpm only. −/+ during a review sets the bpm for the next run, as in Tempo; it does not re-time the review. |
| Clock | `expected(chord) = anchor.realMs + (chord.onMs − anchor.onMs) / speed`. `onMs` already contains the score's written tempo changes. |
| Anchor | The first chord played. Afterwards, every pause chord. Nothing else ever moves the clock. |
| Chord onset | The earliest key among the presses that completed the chord (the "counted press": a re-struck key counts with the press still down when the chord completed). Used for the pause decision and as the anchor's time. |
| Pause | `chordOnset − expected > window × chord.beatMs / speed`. `window` is the review's match window for the chosen criterion (`windowOf(review.settings)`): 0.5 beat at ±20 %, 0.3 at ±10 %. |
| First chord | Untimed: `played`, no `deltaMs`, grey on the Notes layer, `restart: 'first'`. There is no clock before it. |
| Pause chord | Timed against the old clock, so always late beyond the window (full late colour, ▸). `restart: 'pause'`. Counts in "late" and in "N pauses". The clock then restarts from its onset. |
| Per-note timing | Each note is timed on its own: `deltaMs = noteOnset − expected(chord)`, so the spread between the hands shows. Early notes are never a pause. Beyond the window, early or late, the colour clamps at full. |
| On time | The review criterion (`within`): ±10 % or ±20 % of a beat. |
| Notes summary | `W / T within ±20 % · E early · L late · P pauses · X wrong keys · at 50 bpm · 1 beat = 1200 ms`. No median: not informative here. "at N bpm" is the run's bpm, in Follow and Tempo. |
| Velocity | Always measured. |
| Duration | `heldMs` from real times. `durationPct = heldMs / ((offMs − onMs) / speed)`. Undefined when a pause chord's onset falls strictly between the key's on and off. |
| End of the run | When the last chord completes, recording goes on until every key is up, then the review shows. Stop (or Space) ends at once. |
| Missed notes | Don't exist in Follow. Chords not completed when the run stops are left out of the report. |
| Wrong keys | `extras`, placed at the score time of the chord being asked for. Wrong keys before the first chord's first key are dropped. |
| Pedal | Timed against the same clock. A pedal pressed during a stop is untimed (`restart: 'pause'`). A pedal held through a stop keeps its real `heldMs` but gets no `durationPct`. |
| Latency | Not applied (`latencyMs: 0`): timing is relative to played anchors, so device latency cancels out. |
| Re-center | Off and hidden in Follow: each stretch between pauses has its own anchor, so one run-wide offset doesn't fit. |
| Live feedback | Wait-style only: played notes go green. No timing colours while playing. |

The analysis is a pure function re-run on every criterion change (the window decides the pauses).

## Where the code stands (main, 2026-10-25)

| Commit | What |
|---|---|
| `eff5b66` | Follow mode: replay through `WaitMode`, `analyseFollow`, review wording, wiring. |
| `41a3b60`, `7e7ab12` | "Fewest errors at N bpm" and the bar-based start. Both removed by `55a56a5`. |
| `55a56a5` | Back to `eff5b66`'s code (`git checkout eff5b66 -- src test README.md`). |
| `4139267` | One bpm per run: `followRun.speed`, taken at the first key; `retime()` gone, so −/+ only sets the next run's bpm. "at N bpm" in the Notes and Pedal summaries, in Follow and Tempo. |
| `2a90ceb` | A pause chord is timed late against the clock that was running, then restarts it. Only the first chord is grey. No median in the Follow summary. |
| (with this plan) | `scripts/replay-follow.mjs`: replays saved runs and prints the Reference data table. |

Where Follow lives:
- `src/engine/waitMode.ts`: `completions` (the counted press of each completed chord) and `wrongs`.
- `src/engine/follow.ts`: `analyseFollow`: replay, clock walk, notes, extras, pedal.
- `src/engine/align.ts`: `alignPedal` exported, generic over press objects, returns `pressOf`.
- `src/types.ts`: `restart` on `PlayedNote` and `PlayedPedal`.
- `src/review/layers.ts`: `Context.follow` and `Context.bpm`, the grey first chord, `counts().untimed`, `pauses()`, the Follow summary and popover wording.
- `src/review/view.ts`: `show(alignment, speed, bpm, offset, follow)`, Re-center hidden, the Follow key legend.
- `src/main.ts`: `followRun`, `recordFollow`, `finishFollow`, the Follow branch of `analyse()`.
- `scripts/replay-follow.mjs`: saved runs → the Reference data table. Usage in its header.

## Open decisions

- **The first chord sets the clock.** Decided: the first chord (not a count-in) starts the clock. Known cost: if the first chord is off the player's pulse, every note until the next pause shifts with it. Seen in the 17:57 run: bar 2 came 25 % early after the pickup, so bars 2–9 read 25 % more early than they were. Revisit only if it keeps bothering in practice.
- **Pedal pressed during a stop.** Still untimed. By "a stop is late by definition" it could be timed late against the old clock too, like the pause chord.
- **A hand found late in a chord.** The LH is on time, then the RH is found 2 beats later with the LH held. The chord is not a pause (onset = the LH), the RH reads very late, and the next chord becomes the pause instead.
- **Fast passages crossing hands.** Wait asks for chords in strict order. If one hand's next note comes before the other hand's current one, it is a wrong key and must be struck again. Probably rare; check on a fast piece.

## Decided against (and why)

- **Bar-based start** (built in `7e7ab12`, removed in `55a56a5`). Hard to follow, and it fits the clock to the playing.
- **"Fewest errors at N bpm"** (built in `41a3b60`, removed in `55a56a5`). It names a tempo after the fact: retrofitting.
- **−/+ re-timing a finished run** (built in `eff5b66`, removed in `4139267`). Same reason.
- **Grey, untimed pause chords** (built in `eff5b66`, changed in `2a90ceb`). A stop is late by definition. Grey also hid the worst chord of a drag, and made a chord just past the window look better than one just inside it.
- **Timing only the pause chords under 1 beat late.** Superseded by timing every pause chord.
- **A median in the Follow summary.** Not informative. The median that matters in Tempo is the run's offset for re-center, and Follow has no re-center.
- **A count-in** (one bar of clicks at the set bpm, then silence, so the first chord is timed too). Offered on 2026-10-25; the user chose the first chord instead. It would need a Start button and the calibrated latency.
- **A fixed pause threshold** (1 or 2 beats) instead of the match window. Tested on both saved runs (table below): a hesitation that is no longer a pause leaves the clock behind, so every note after it reads late until the next pause.
- **A played-tempo estimate** ("played 51 → 44 bpm"). Sections can't be defined easily and consistently.
- **Re-center in Follow.** One run-wide offset doesn't fit stretches with their own anchors.

## Reference data

Saved runs (gitignored, `runs/`), both "Waltz in A minor" at 50 bpm (score 65 bpm, `speed` 0.769), hands both, whole piece:
- `runs/Waltz in A minor 2026-10-25T1718.json`: stopped at bar 33, 158 chords.
- `runs/Waltz in A minor 2026-10-25T1757.json`: complete, 878 notes.

The score is in the user's device library, not in `public/scores`. Its MuseScore export is `~/Documents/MuseScore4/Scores/export/Waltz in A minor.musicxml`.

Pause rule compared on both runs, at 50 bpm, with the first-chord clock. `node scripts/replay-follow.mjs <score> <runs> --pause=1,2`, 2026-10-25, on `2a90ceb` (pause chords timed late):

| run | pause rule | ±20 %: within | early | late | untimed | pauses | beyond the colour range | total | ±10 %: within | pauses |
|---|---|---|---|---|---|---|---|---|---|---|
| 1718 | match window (kept) | 186 | 61 | 118 | 1 | 20 | 55 | 366 | 138 | 26 |
| 1718 | 1 beat | 86 | 71 | 208 | 1 | 12 | 151 | 366 | 40 | 12 |
| 1718 | 2 beats | 76 | 1 | 288 | 1 | 8 | 253 | 366 | 44 | 8 |
| 1757 | match window (kept) | 249 | 220 | 408 | 1 | 92 | 356 | 878 | 183 | 110 |
| 1757 | 1 beat | 224 | 196 | 457 | 1 | 64 | 428 | 878 | 129 | 64 |
| 1757 | 2 beats | 109 | 179 | 589 | 1 | 43 | 620 | 878 | 52 | 43 |

With grey pause chords (`eff5b66`), the 1757 run read the same within and pauses, but late 175 / 278 / 480 and untimed 234 / 180 / 110: the pause chords' notes moved from untimed to late. The script reproduces that older table exactly when run against `55a56a5`.

70 of the 92 pauses are in bars 40 and later: the second half was stop-and-start at any threshold.

Note: Save run writes `untilMs: Infinity` as `null` in the JSON.

## Manual test checklist (tablet / laptop + piano)

- [ ] Follow plays exactly like Wait: chord-at-once rule, red flash, greens, progress line, scrolling.
- [ ] Steady playing at the set bpm → mostly green in the Notes layer, 0 pauses. The first chord is grey.
- [ ] A deliberate stop to change position → that chord is full late with ▸, timing afterwards is sensible, 1 pause.
- [ ] Slowly dragging → amber/brown growing, then a pause at full late, then back to small.
- [ ] 10 % ↔ 20 % in the review recomputes the pauses.
- [ ] −/+ during a review changes the top bpm only; the review, and its "at N bpm", stay as they were. The next run uses the new bpm.
- [ ] −/+ during a run doesn't change that run's review.
- [ ] The review appears when the last chord is let go. Its Duration is measured.
- [ ] Duration, Velocity and Pedal layers populated. A note held through a stop is grey on Duration. A pedal pressed during a stop is grey.
- [ ] Bars section and Left/Right work. Stop mid-way shows a partial review, and keys after it do nothing until Restart.
- [ ] Save run → JSON has `mode: "follow"` and the run's bpm. `__replay(json.recording, json.speed, Infinity, 'follow')` reproduces the review.
- [ ] Wait and Tempo unchanged, except "at N bpm" in Tempo's summary.

## Out of scope / later

- **Ritardando, accelerando and fermatas.** Tempo changes written as metronome marks are already in `onMs` and are followed automatically. An unmarked *rit.* shows as growing lateness and then a pause.
- Live timing colours (decided: not now).
- Several wrong keys on one chord: their × markers sit on one spot. Merge them into one marker listing the pitches, if it bothers.
