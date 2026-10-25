# Plan: Follow mode

Handoff, 2026-10-25. Follow mode is implemented and on `main`. After testing it on the piano, the user set one principle, and some of what was built breaks it. **The next session starts with "To do next" below.**

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
| `65beca0` | The first version of this plan. |
| `eff5b66` | Follow mode: replay through `WaitMode`, `analyseFollow`, review wording, wiring. **Keep**, except `retime()` (−/+ re-timing a review, step 2) and grey pause chords (step 3). |
| `41a3b60` | "Fewest errors at N bpm" button; tapping it re-times the review there. **Remove** (step 1). |
| `7e9985b` | Plan notes only. |
| `7e7ab12` | Bar-based start: each stretch's clock moved once to the median of its first bar. **Remove** (step 1). |

`41a3b60` and `7e7ab12` are the only commits after `eff5b66` that touch `src/`, `test/` or `README.md` (`git log eff5b66..HEAD -- src test README.md`).

Where Follow lives, as of `eff5b66`:
- `src/engine/waitMode.ts`: `completions` (the counted press of each completed chord) and `wrongs`.
- `src/engine/follow.ts`: `analyseFollow`: replay, clock walk, notes, extras, pedal.
- `src/engine/align.ts`: `alignPedal` exported, generic over press objects, returns `pressOf`.
- `src/types.ts`: `restart` on `PlayedNote` and `PlayedPedal`.
- `src/review/layers.ts`: `Context.follow`, untimed notes grey, `counts().untimed`, `pauses()`, the Follow summary and popover wording.
- `src/review/view.ts`: `show(…, follow)`, Re-center hidden, the Follow key legend.
- `src/main.ts`: `followRun`, `recordFollow`, `finishFollow`, the Follow branch of `analyse()`, `retime()`.

## To do next

`npm test` and `npm run build` must pass after each step. One commit per step.

**Step 1: back to `eff5b66`'s code.** Check that the log above still holds, then `git checkout eff5b66 -- src test README.md`. This removes the bar-based start and "fewest errors", with their tests and README sentences.

**Step 2: one bpm per run.**
- `main.ts`: remove `retime()` and its calls in the −/+ handlers.
- Add `speed` to `followRun` when `recordFollow` creates it, and use it in `finishFollow`. Today `finishFollow` reads the current `speed`, so −/+ pressed during a run would change it. Tempo already works this way: `TempoRun` takes `speed` in its constructor.
- `layers.ts`: add `at N bpm` before `1 beat = …` in the Notes summary, in Follow and Tempo, from the run's `speed`. `Context` needs the bpm.
- README: remove "−/+ during the review times the same playing at another bpm"; mention "at N bpm".
- Tests: update the summary assertions in `test/layers.test.ts`. The bpm test in `test/follow.test.ts` ("the practice speed sets the clock") stays: `analyseFollow` is still a function of `speed`.

**Step 3: pause chords timed late; no median in Follow.**
- `follow.ts`, the clock walk: on a pause, `expectedAt.set(c.chord, at)` (the old clock) before pushing the new anchor. Only the first chord stays untimed.
- `layers.ts`:
  - `describe()`: a pause chord shows its timing and then "clock restarted here (pause)".
  - `summary()` in Follow: drop `median …` and the RH/LH medians. Tempo keeps them.
  - `counts().untimed` is now only the first chord.
- Tests:
  - `test/follow.test.ts`: in "a stop", "drift is not forgiven" and "the match window decides", the pause chord now has a late `deltaPct` (drift: 15, 30, 45, 60, then 15).
  - `test/layers.test.ts`, the Follow test: n2 is no longer grey, counts are `within 2, late 1, untimed 1`, and the summary has no median.
- README: "a pause is grey, untimed" becomes "the chord after a stop is late, and the clock restarts there".

**Step 4: replay script, and check.**
- Write `scripts/replay-follow.mjs` and commit it. It takes a saved run's JSON and the score's MusicXML, and prints a row of the Reference data table at ±20 % and ±10 %. `playwright-core` stays out of `package.json`: the script's header says how to install it in a scratch directory and how to start the dev server. See "How these were computed".
- Replay the 17:57 run at ±20 %. It should give 249 within and 92 pauses as before. Late goes from 175 to 175 + 234 − the first chord's notes, and untimed drops to the first chord's notes.
- Update this plan: replace "Where the code stands" and "To do next" with what was done, and add the new row to Reference data.

## Open decisions

- **The first chord sets the clock.** Decided: the first chord (not a count-in) starts the clock. Known cost: if the first chord is off the player's pulse, every note until the next pause shifts with it. Seen in the 17:57 run: bar 2 came 25 % early after the pickup, so bars 2–9 read 25 % more early than they were. Revisit only if it keeps bothering in practice.
- **Pedal pressed during a stop.** Still untimed. By "a stop is late by definition" it could be timed late against the old clock too, like the pause chord.
- **A hand found late in a chord.** The LH is on time, then the RH is found 2 beats later with the LH held. The chord is not a pause (onset = the LH), the RH reads very late, and the next chord becomes the pause instead.
- **Fast passages crossing hands.** Wait asks for chords in strict order. If one hand's next note comes before the other hand's current one, it is a wrong key and must be struck again. Probably rare; check on a fast piece.

## Decided against (and why)

- **Bar-based start** (built in `7e7ab12`, removed in step 1). Hard to follow, and it fits the clock to the playing.
- **"Fewest errors at N bpm"** (built in `41a3b60`, removed in step 1). It names a tempo after the fact: retrofitting.
- **−/+ re-timing a finished run** (built in `eff5b66`, removed in step 2). Same reason.
- **Grey, untimed pause chords** (built in `eff5b66`, changed in step 3). A stop is late by definition. Grey also hid the worst chord of a drag, and made a chord just past the window look better than one just inside it.
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

Pause rule compared on the complete run, at 50 bpm, with the first-chord clock and grey pause chords (`eff5b66`):

| pause rule | ±20 %: within | late | untimed | pauses | beyond the colour range | ±10 %: within | pauses |
|---|---|---|---|---|---|---|---|
| match window (kept) | 249 | 175 | 234 | 92 | 123 | 183 | 110 |
| 1 beat | 224 | 278 | 180 | 64 | 249 | 129 | 64 |
| 2 beats | 109 | 480 | 110 | 43 | 511 | 52 | 43 |

70 of the 92 pauses are in bars 40 and later: the second half was stop-and-start at any threshold.

How these were computed (the scripts lived in a session scratchpad and are gone; step 4 puts them in `scripts/`):
- Start the dev server (`npx vite --port 5199 --strictPort`).
- Drive headless Chromium (`/usr/bin/chromium`) with `playwright-core`, installed in a scratch directory, not in the project.
- In the page, `await import('/src/engine/follow.ts')` and `await import('/src/score/load.ts')`. `loadScore({ kind: 'xml', text }, title)` gives the `ScoreTiming` for the exported MusicXML.
- Call `analyseFollow(timing.events, run.recording, run.speed, { hands: 'both', window: run.window, pauseBeats }, timing.pedals)`.
- Note: Save run writes `untilMs: Infinity` as `null` in the JSON.

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
