# Plan: Follow mode

Handoff, 2026-10-25. Follow mode is implemented and on `main`, following the principle below. **Next: the manual test checklist on the piano.**

## What Follow is

A third practice mode between Wait and Tempo: **Wait · Follow · Tempo**.

While playing, Follow behaves exactly like Wait. The score waits for each chord, all of it held down at once. A wrong key flashes red and does not advance. Played notes turn green. There is no metronome and no count-in.

Nothing is timed while playing: the keys are only recorded. When the run ends, the analysis lays a clock at the run's bpm over the recording, and the score shows the same review as Tempo: the Notes/Timing, Duration, Velocity and Pedal layers, the tap popover and Save run.

## The principle (decided 2026-10-25)

**One tempo, agreed before playing. No retrofitting.**

> "There should be only one tempo which I agree beforehand, no retrofitting. It doesn't make sense to say: I wanted to play it at 50 bpm but I ended up playing it faster and it's good. Even if I don't play with a metronome, there should be one tempo I follow."

So the review never adapts the clock's tempo to how the run was played, and never fits its starting point to the playing. The only things that move the clock are the first chord and chords counted as errors.

**There are no pauses or stops: only chords too early or too late** (decided 2026-10-25). A chord with every key outside the criterion is marked ◂ or ▸ and the clock restarts from it, so drift builds up to the criterion and no further, and every restart is visible as a mark. A stop is just a very late chord.

## Rules (decided)

| Thing | Rule |
|---|---|
| Tempo | The practice bpm set with −/+ (`speed`, per-score memory, shared with Tempo), **taken when the run starts** (its first key) and fixed for that run. The review is timed at that bpm only. −/+ during a review sets the bpm for the next run, as in Tempo; it does not re-time the review. |
| Clock | `expected(chord) = anchor.realMs + (chord.onMs − anchor.onMs) / speed`. `onMs` already contains the score's written tempo changes. |
| Anchor | The first chord played. Afterwards, every restart chord. Nothing else ever moves the clock. |
| Counted press | The press that completed the chord: a re-struck key counts with the press still down when the chord completed. |
| Restart | Every key of the chord outside the criterion on the same side: `min(keys) − expected > tol` (late) or `max(keys) − expected < −tol` (early), `tol = within × chord.beatMs / speed`. One key inside keeps the clock (a hand found late reads late, the clock stays). |
| First chord | Untimed: `played`, no `deltaMs`, grey on the Notes layer, `restart: 'first'`. There is no clock before it. |
| Restart chord | Timed against the clock that was running, so marked ◂ or ▸. `restart: 'outside'`; the popover adds "clock restarted here". The clock then restarts from its earliest key. |
| Per-note timing | Each note is timed on its own: `deltaMs = noteOnset − expected(chord)`, so the spread between the hands shows. Beyond the match window (`windowOf`: 0.5 beat at ±20 %, 0.3 at ±10 %), early or late, the colour clamps at full. |
| On time | The review criterion (`within`): ±10 % or ±20 % of a beat. It also decides the restarts. |
| Notes summary | `W / T within ±20 % · E early · L late · X wrong keys · at 50 bpm · 1 beat = 1200 ms`. No pause count, no median. "at N bpm" is the run's bpm, in Follow and Tempo. |
| Legend | `◂ ▸ outside ±20 % (a whole chord: the clock restarts there) · ■ clock started · × wrong key`. |
| Velocity | Always measured. |
| Duration | `heldMs` from real times. `durationPct = heldMs / ((offMs − onMs) / speed)`, always, also for a key held through a restart. |
| End of the run | When the last chord completes, recording goes on until every key is up, then the review shows. Stop (or Space) ends at once. |
| Missed notes | Don't exist in Follow. Chords not completed when the run stops are left out of the report. |
| Wrong keys | `extras`, placed at the score time of the chord being asked for. Wrong keys before the first chord's first key are dropped. |
| Pedal | Matched to its sign on the clock as it stands (it stops at the next restart chord when playing late, so the axis stays in order), timed against the clock that was running: a pedal pressed while late reads late, as its chord. Match window: the review's (`matchBeats`). `heldMs` and `durationPct` always measured. |
| Latency | Not applied (`latencyMs: 0`): timing is relative to played anchors, so device latency cancels out. |
| Re-center | Off and hidden in Follow: each stretch between restarts has its own anchor, so one run-wide offset doesn't fit. |
| Live feedback | Wait-style only: played notes go green. No timing colours while playing. |

The analysis is a pure function re-run on every criterion change (the criterion decides the restarts).

## Where the code stands (main, 2026-10-25)

| Commit | What |
|---|---|
| `eff5b66` | Follow mode: replay through `WaitMode`, `analyseFollow`, review wording, wiring. |
| `41a3b60`, `7e7ab12` | "Fewest errors at N bpm" and the bar-based start. Both removed by `55a56a5`. |
| `55a56a5` | Back to `eff5b66`'s code (`git checkout eff5b66 -- src test README.md`). |
| `4139267` | One bpm per run: `followRun.speed`, taken at the first key; `retime()` gone, so −/+ only sets the next run's bpm. "at N bpm" in the Notes and Pedal summaries, in Follow and Tempo. |
| `2a90ceb` | A pause chord (later than the match window) is timed late against the clock that was running, then restarts it. Only the first chord is grey. No median in the Follow summary. |
| `1678bee` | `scripts/replay-follow.mjs`: replays saved runs and prints the Reference data table. |
| `2d98006` | No pauses: a chord all outside the criterion, early or late, restarts the clock. No pause count; no special case for notes or pedals held through a restart; a pedal pressed while late reads late. `FollowOptions`: `within` and `matchBeats` instead of `pauseBeats`. |

Where Follow lives:
- `src/engine/waitMode.ts`: `completions` (the counted press of each completed chord) and `wrongs`.
- `src/engine/follow.ts`: `analyseFollow`: replay, clock walk, notes, extras, pedal.
- `src/engine/align.ts`: `alignPedal` exported, generic over press objects, returns `pressOf`.
- `src/types.ts`: `restart: 'first' | 'outside'` on `PlayedNote`.
- `src/review/layers.ts`: `Context.follow` and `Context.bpm`, the grey first chord, `counts().untimed`, the Follow summary and popover wording.
- `src/review/view.ts`: `show(alignment, speed, bpm, offset, follow)`, Re-center hidden, the Follow key legend.
- `src/main.ts`: `followRun`, `recordFollow`, `finishFollow`, the Follow branch of `analyse()`.
- `scripts/replay-follow.mjs`: saved runs → the Reference data table. Usage in its header.

## Open decisions

- **The first chord sets the clock.** Decided: the first chord (not a count-in) starts the clock. Known cost: if the first chord is off the player's pulse, every note until the next restart shifts with it. With restarts at the criterion this lasts only until the first chord outside it.
- **One slip gives two marks.** A chord too late restarts the clock there; back on the pulse, the next chord reads early and restarts it again (19:34 run, bars 8–9: ▸49 ▸84 ▸31, then ◂−40). Accepted for now: it is what the clock measures.
- **A hand found late in a chord.** The LH is on time, then the RH is found 2 beats later with the LH held. The chord doesn't restart the clock (one key inside), the RH reads very late, and the next chord probably restarts it instead.
- **Fast passages crossing hands.** Wait asks for chords in strict order. If one hand's next note comes before the other hand's current one, it is a wrong key and must be struck again. Probably rare; check on a fast piece.

## Decided against (and why)

- **Bar-based start** (built in `7e7ab12`, removed in `55a56a5`). Hard to follow, and it fits the clock to the playing.
- **"Fewest errors at N bpm"** (built in `41a3b60`, removed in `55a56a5`). It names a tempo after the fact: retrofitting.
- **−/+ re-timing a finished run** (built in `eff5b66`, removed in `4139267`). Same reason.
- **Grey, untimed pause chords** (built in `eff5b66`, changed in `2a90ceb`). A stop is late by definition. Grey also hid the worst chord of a drag, and made a chord just past the window look better than one just inside it.
- **Pauses (later than the match window, 50 % at ±20 %), late only** (built in `eff5b66`, removed in `2d98006`). Drift built up unseen to 50 %, then the clock reset to "on time" with nothing on the score saying so; early never reset, so rushing grew without limit (19:34 run, bars 10–13: down to −59 %). A pause count beside early/late said nothing new.
- **Restarting at the criterion, late only.** Tried on the 19:34 run: after a slip the clock sits late, the playing reads early, and with no early restart it grew to −90 %.
- **Timing only the pause chords under 1 beat late.** Superseded.
- **A median in the Follow summary.** Not informative. The median that matters in Tempo is the run's offset for re-center, and Follow has no re-center.
- **A count-in** (one bar of clicks at the set bpm, then silence, so the first chord is timed too). Offered on 2026-10-25; the user chose the first chord instead. It would need a Start button and the calibrated latency.
- **A fixed pause threshold** (1 or 2 beats). Tested on the 17:57 and 17:18 runs: a hesitation below it leaves the clock behind, so every note after it reads late until the next restart.
- **A played-tempo estimate** ("played 51 → 44 bpm"). Sections can't be defined easily and consistently.
- **Re-center in Follow.** One run-wide offset doesn't fit stretches with their own anchors.

## Reference data

Saved runs (gitignored, `runs/`), all "Waltz in A minor" at 50 bpm (score 65 bpm, `speed` 0.769), hands both:
- `runs/Waltz in A minor 2026-10-25T1718.json`: stopped at bar 33, 366 notes.
- `runs/Waltz in A minor 2026-10-25T1757.json`: complete, 878 notes.
- `runs/Waltz in A minor 2026-10-25T1934.json`: stopped at bar 25, 268 notes. Tested on `2a90ceb`; its review prompted the restarts at the criterion.

The score is in the user's device library, not in `public/scores`. Its MuseScore export is `~/Documents/MuseScore4/Scores/export/Waltz in A minor.musicxml`.

`node scripts/replay-follow.mjs <score> <runs>` on `2d98006` (restart at the criterion, early and late):

| run | ±20 %: within | early | late | untimed | clock restarts | beyond the colour range | total | ±10 %: within | early | late | clock restarts |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1718 | 261 | 18 | 86 | 1 | 39 | 54 | 366 | 190 | 65 | 110 | 67 |
| 1757 | 504 | 58 | 315 | 1 | 156 | 217 | 878 | 399 | 133 | 345 | 193 |
| 1934 | 184 | 19 | 64 | 1 | 31 | 37 | 268 | 140 | 46 | 81 | 47 |

The same runs with pauses at the match window, late only (`2a90ceb`), at ±20 %: 1718 within 186, early 61, late 118, 20 pauses; 1757 within 249, early 220, late 408, 92 pauses; 1934 within 116, early 45, late 106, 14 pauses.

The 19:34 run, bars 3–6, % of a beat per chord (‖ = the clock restarts):
- pauses at 50 %: `b3: 8 8 7 27 · b4: 35 31 29 27 27 30 · b5: 31 37 42 ‖50 · b6: −1 −3 −5 1`
- restart at the criterion: `b3: 8 8 7 ‖27 · b4: 8 5 2 0 0 3 · b5: 5 10 15 ‖24 · b6: −1 −3 −5 1`

Note: Save run writes `untilMs: Infinity` as `null` in the JSON.

## Manual test checklist (tablet / laptop + piano)

- [ ] Follow plays exactly like Wait: chord-at-once rule, red flash, greens, progress line, scrolling.
- [ ] Steady playing at the set bpm → mostly green in the Notes layer, no ◂ ▸. The first chord is grey.
- [ ] A deliberate stop to change position → that chord is full late with ▸, its popover says "clock restarted here", timing afterwards is sensible.
- [ ] Slowly dragging → lateness growing to the criterion, a ▸, then back to small. Rushing the same, with ◂.
- [ ] Is it clear on the score where the clock restarted? (The reason for this change.)
- [ ] 10 % ↔ 20 % in the review recomputes the restarts.
- [ ] −/+ during a review changes the top bpm only; the review, and its "at N bpm", stay as they were. The next run uses the new bpm.
- [ ] −/+ during a run doesn't change that run's review.
- [ ] The review appears when the last chord is let go. Its Duration is measured.
- [ ] Duration, Velocity and Pedal layers populated; a note held through a stop has its duration. A pedal pressed during a stop reads late.
- [ ] Bars section and Left/Right work. Stop mid-way shows a partial review, and keys after it do nothing until Restart.
- [ ] Save run → JSON has `mode: "follow"` and the run's bpm. `__replay(json.recording, json.speed, Infinity, 'follow')` reproduces the review.
- [ ] Wait and Tempo unchanged, except "at N bpm" in Tempo's summary.

## Out of scope / later

- **Ritardando, accelerando and fermatas.** Tempo changes written as metronome marks are already in `onMs` and are followed automatically. An unmarked *rit.* shows as growing lateness, then ▸ and a restart, repeatedly.
- Live timing colours (decided: not now).
- Several wrong keys on one chord: their × markers sit on one spot. Merge them into one marker listing the pitches, if it bothers.
