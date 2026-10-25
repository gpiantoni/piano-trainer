# Plan: Follow mode

A third practice mode between Wait and Tempo: **Wait · Follow · Tempo**.

While playing, Follow behaves exactly like Wait. The score waits for each chord, all of it held down at once. A wrong key flashes red and does not advance. Played notes turn green. There is no metronome and no count-in.

Nothing is timed while playing: the keys are only recorded. When the run ends, the analysis lays a clock at the set bpm over the recording, and the score shows the same review as Tempo: the Notes/Timing, Duration, Velocity and Pedal layers, the tap popover and Save run. All timing is judged against that clock:

- **Drift is not forgiven** within a stretch of playing: the clock is never nudged towards the player.
- **Stops are forgiven.** A chord more than the match window late counts as a pause. Its notes get no timing and the clock restarts from that chord.

Because the clock exists only after the run, −/+ bpm during a review re-times it: the same recording, judged at the new tempo.

Wait and Tempo stay unchanged, except for the small instrumentation of `WaitMode` described in step 1.

## Rules (decided)

| Thing | Rule |
|---|---|
| Tempo | The set practice bpm (`speed`, the same −/+ control and per-score memory as Tempo). Not inferred from playing. During a Follow review, −/+ re-runs the analysis at the new bpm, and Save run records the bpm in use. |
| Fewest errors | Added after the first runs. The review also times the run at every bpm −/+ can reach (and at its own), and names the one with the most notes within the selected criterion: `fewest errors at 50 bpm (186 / 366)`. Ties go to the nearest to the run's bpm. Tapping it re-times the review there and sets the bpm; the review still opens at the bpm you set. No played-tempo estimate: sections can't be defined easily and consistently. |
| Clock | `expected(chord) = anchor.realMs + (chord.onMs − anchor.onMs) / speed`. `onMs` already contains the score's written tempo changes. |
| Anchor | The first chord played. Afterwards, every chord that counts as a pause. Nothing else ever moves the anchor. |
| Bar-based start | Added 2026-10-25. Each stretch (from an anchor to the next pause) starts its clock on the anchor. At the first chord one bar (the meter's, at the anchor) after it, the clock is moved once by the median offset of the chords so far: the anchor and the chords in its bar, each chord counted by the median of its keys. The tempo stays the set one, so drift still builds up after that bar. Pauses in the first bar are decided on the unmoved clock, later ones on the moved clock. |
| Chord onset | The earliest on-time among the presses that completed the chord (see "counted press" below). Used for the pause decision and as the anchor's time. |
| Pause | `chordOnset − expected > window × chord.beatMs / speed`. Here `window` is the review's match window for the chosen criterion (`windowOf(review.settings)`): 0.5 beat at 20 %, 0.3 at 10 %. Kept for v1; see "Open questions for testing". |
| Pause chord | Becomes the new anchor. With the bar-based start it is timed against the bar after it; in a stretch that ends within its first bar it stays untimed: no `deltaMs`, grey on the Notes layer. The first chord of a run is treated the same way. Either way it keeps `restart` and counts as a pause. |
| Per-note timing | Each note is timed individually: `deltaMs = noteOnset − expected(chord)`. This makes the spread between the hands visible note by note, as in Tempo. Early notes are never a pause. Rushing beyond the window just clamps at full "early" colour. |
| On time | The review criterion, unchanged (`within`, 20 % for Joe). |
| Velocity | Always measured. |
| Duration | `heldMs` comes from real times. `durationPct = heldMs / ((offMs − onMs) / speed)`. It is `undefined` when a pause anchor's onset falls strictly between the key's on and off, because a note held through a stop has a meaningless length. |
| End of the run | When the last chord completes, recording goes on until every key is up, then the review shows. So the last chord's durations are measured. Stop (or Space) ends at once. |
| Missed notes | Do not exist in Follow: a chord must be played to advance. Notes of chords not completed when the run stops are left out of the report (as `untilMs` does in Tempo). |
| Wrong keys | Become `extras`. Each is placed at the clock time of the chord that was current when it was pressed. `wrongFor` stays undefined. Wrong keys before the first counted press of the first chord are dropped: the run hadn't started. |
| Pedal | Timed against the same clock. A pedal pressed during a pause (while the clock is clamped, see step 2) is untimed. A pedal held through a pause keeps its real `heldMs` but gets no `durationPct`, as a key. |
| Latency | Not applied (`latencyMs: 0`). All timing is relative to played anchors, so device latency cancels out. Keys and pedal share the same latency. |
| Re-center | Off and hidden in Follow. It subtracts one median offset for the whole run, but each stretch between pauses has its own anchor, so one run-wide offset doesn't fit them. |
| Live feedback | Wait-style only: every played note goes green. No timing colours while playing. |

Changing the review criterion (10 % ↔ 20 %) changes the window, and therefore which chords count as pauses. Changing the bpm changes every expected time. So the analysis must be a **pure function re-run on every `realign` and every −/+**, as `analyse()` already does for Tempo.

## Step 1: instrument `WaitMode` (`src/engine/waitMode.ts`)

Keep the behaviour identical. All existing tests must pass untouched.

- `held` changes from `Set<number>` to `Map<number, { t: number; velocity: number }>`, mapping pitch → the press that is currently down.
  - Re-striking a chord note replaces the entry. The **counted press** is the one still down at completion.
  - An `off` event deletes the entry, as now.
- Add `readonly completions: Completion[]`, where
  `type Completion = { chord: number; presses: Map<number, { t: number; velocity: number }> }`.
  Push one entry in `handle()` when a chord completes, before `enter(cursor + 1)`. Storing `held` itself is safe: `enter()` replaces it with a new map.
- Add `readonly wrongs: { pitch: number; t: number; velocity: number; chord: number }[]`, pushed where `wrong++` happens.
- `restart()` clears both arrays.
- Update `expected` and any other code that reads `held`.

## Step 2: pure analysis (`src/engine/follow.ts`, new)

No DOM, no clock: tested in Node like `align.ts`.

```ts
export type FollowOptions = {
  hands: Hands;
  window: { startMs: number; endMs: number };   // the section; only the pedal needs it
  pauseBeats: number;                            // = review match window
};

export function analyseFollow(
  events: ExpectedEvent[],      // practiceEvents(timing): the section's notes
  recording: NoteEvent[],       // raw, t = real ms from the run's first event
  speed: number,
  opts: FollowOptions,
  pedalMarks: PedalMark[],
): Alignment
```

**1. Replay.** Feed the recording, **in recorded order** (not re-sorted: `__play` sends an on and an off with the same `t`), through a fresh `new WaitMode(events, opts.hands)`. Read `completions` and `wrongs` from it. Replaying makes Save run / `__replay` work with the recording alone, so nothing else needs storing.

**2. Anchors.** Walk the completions in order.
- Chord onset = the min `t` of its presses.
- The first completion is an anchor.
- Every other completion is checked against `expected` from the current anchor. If it is later than `pauseBeats × beatMs / speed`, it becomes a new anchor and is marked untimed.

**3. Clock map** `clock(realMs) → ms on the score axis at this speed` (score ms / speed). It is used for the notes' `onsetMs` and to place pedal events.
- Within the anchor segment that starts at real time `A.r` with clock time `A.c = chord.onMs / speed`: `clock = A.c + (real − A.r)`.
- Before the first anchor, the same line extended backwards: a pedal pressed before the first chord reads as early.
- Clamp to the next anchor's `c`. Events during a pause then land at the restart chord instead of overshooting and jumping back, and the mapping stays monotonic. Remember which events were clamped: they happened during a stop.

**4. Notes.** For every expected event in the completed chords (`WaitMode` already left out the other hand, and `events` are the section's):
- `onsetMs = clock(press.t)`
- `deltaMs`: undefined for anchor chords, otherwise `press.t − expected(chord)`
- `deltaPct = deltaMs / (beatMs / speed) × 100`
- `velocity`, `velocityPct`
- `heldMs` and `pedal` from `keyPresses(recording)` (already exported from `align.ts`), matched on `pitch` and `on === press.t`
- `durationPct` per the rule above
- `status: 'played'`
- `restart: 'first'` on the first chord, `restart: 'pause'` on pause chords

A unison (both hands on one pitch) gives both events the same press.

**5. Extras.** `wrongs`, minus those before the first chord's onset → `{ pitch, onsetMs: chords[w.chord].onMs / speed, velocity, velocityPct }`. This is the clock time of the chord that was being asked for.

**6. Pedal.** Export `alignPedal` from `align.ts`. Feed it the pedal events of the recording with `t` mapped through `clock()`.
- Set `untilMs` to the clock time of the last completed chord.
- Set `from`/`to` as `align` computes them from the window, with `biasMs` = 0.
- Afterwards, on each `PlayedPedal`:
  - A down that was clamped → `deltaMs` undefined, `restart: 'pause'`.
  - An anchor's onset strictly inside its span → `heldMs` from the real times, `durationPct` undefined.
  - Pedal extras keep their clock-mapped `atMs`.

## Step 3: types (`src/types.ts`)

- `PlayedNote`: add `restart?: 'first' | 'pause'`, documented as "Follow: the clock started on this chord (first) or restarted after a stop (pause); untimed".
- `PlayedPedal`: add `restart?: 'pause'`, "Follow: pressed during a stop; untimed".
- `deltaMs` is already optional. The review just has to cope with it being undefined on a played note.
- The number of pauses is not stored: it is the number of distinct chords (`onMs`) with `restart === 'pause'`.

## Step 4: review copes with untimed notes (`src/review/layers.ts`, `view.ts`)

- `Context` gets `follow: boolean`, set from `show()`.
- `position()` for `'notes'`: return `undefined` when `deltaMs` is undefined. This makes the note grey (`NOT_MEASURED`).
- `outside()`: return `undefined` when untimed.
- `counts()`: count untimed played notes as neither within, early nor late. Add `untimed` to the result. `total` stays all notes in the report.
- `summary()` for `'notes'`:
  - Medians only over timed notes.
  - In Follow: `W / T within ±10 % · E early · L late · P pauses · X wrong keys · median … · 1 beat = N ms`. No `missed`, no `extra`.
- `summary()` for `'pedal'`: `down` counts pedals with `atMs`, not `deltaMs`, so an untimed one still counts as down. The within count and median stay over timed ones.
- `describe()`: for an untimed note show `clock started here` (`first`) or `clock restarted here (pause)` instead of the ms/% part. Keep held and velocity.
- `describePedal()`: `pedal down (Ped.) · during a pause` for an untimed down, not `missed`.
- `runOffset()` already skips undefined `deltaMs` (checked).
- `ReviewView.show(alignment, speed, offset, follow = false)`:
  - In Follow, hide the Re-center button and force `biasMs` 0 in `context()`.
  - `offsetPart()` prints nothing in Follow (it would otherwise say "re-center needs ≥ 50 timed notes" when the saved setting is on).
- `renderStrip()` key legend for the Notes layer in Follow: `◂ ▸ outside ±10 %`, grey `clock restarted`, `× wrong key`.

## Step 5: wiring (`src/main.ts`)

**Mode**
- `type Mode = 'wait' | 'follow' | 'tempo'`. Add `<button data-mode="follow" role="radio">Follow</button>` between Wait and Tempo. Add `'follow'` to `oneOf`.
- Rename the scroll function `follow()` to `scrollToCurrent()`: "follow" now names the mode.

**`setMode`**
- In Follow show `#restart`, `#waitFeedback` and `#tempoControls`.
- Inside `#tempoControls`, hide `#click`, `#subdivide` and `#latency` in Follow and keep the speed −/+.
- `#startStop` in Follow: shown only while a run is in progress, labelled **Stop**. Hidden otherwise. Restart is the one way to go again, before or after a review.

**State**
- Reuse `practice: WaitMode` for live play.
- Add `let followRun: { t0: number; recording: NoteEvent[]; down: Set<number> } | undefined`.
- `t0` = the `t` of the first key or pedal down after `restart()`. `down` tracks the keys currently held, to know when the last chord is let go.

**`onNote`**
- In Follow, while a review is shown: ignore everything until Restart. After a Stop mid-way, `practice` is not done and would otherwise keep advancing.
- A run cut short without a review (Bars, Library, or Stop before any chord): the next key restarts from the top.
- Otherwise: `followRun.recording.push({ ...ev, t: ev.t - t0 })` for every event, including pedal and wrong keys, and update `down`.
- Then the existing wait handling (`practice.handle`, `flashWrong`, `paint`, `scrollToCurrent()`).
- Once `practice.done` and `down` is empty, call `finishFollow()`.

**`finishFollow()`** (also bound to Stop, and to Space in Follow)
- If at least one chord completed: set `lastRun = { mode: 'follow', recording, speed, latencyMs: 0, recordedAt, untilMs: Infinity, window: playWindow(timing, section) }`, call `analyse()`, then `scrollToStart()`.
- Add `mode` to `LastRun` so `downloadRun` writes it and `__replay` can dispatch on it.

**`analyse()`**
- If `lastRun.mode === 'follow'`:
  ```ts
  analyseFollow(practiceEvents(timing), recording, lastRun.speed,
    { hands, window, pauseBeats: review.window }, timing.pedals)
  ```
  then `review.show(result, lastRun.speed, { ms: undefined, notes: 0 }, true)`, and `lastOffset = undefined`.
- Otherwise keep the Tempo path as it is.

**−/+ bpm**
- After `setBpm()`, if `mode === 'follow'` and a Follow review is shown: `lastRun = { ...lastRun, speed }` and `analyse()`. Tempo reviews keep the bpm they were played at.

**`paint()`**
- Use wait note states when `mode === 'wait' || (mode === 'follow' && !review.active)`.
- During a Follow review, review colours replace the greens, as in Tempo.
- The progress line is the same as Wait's for Follow while playing.

**`setHands`**
- In Follow, always `restart()`. The hand choice decided what was asked, so a review can't be re-cut by hand.

**`restart()`**
- Also clears `followRun` and hides `#startStop`. The first event after it starts a new run and shows Stop.

**`keepAwake`**
- Also keep the screen on while a Follow run is in progress.

**`__replay(recording, speed, untilMs, mode = 'tempo')`**
- Dispatch on `mode`, so a saved Follow run can be replayed.

## Step 6: tests (`test/follow.test.ts`, new; extend `test/waitMode.test.ts`)

Use the helpers from `waitMode.test.ts`, with `beatMs: 500`, `speed: 1`, `pauseBeats: 0.5`. Build recordings with explicit `t`. Keep test values off the exact pause boundary.

1. **WaitMode completions**: a chord completed with a re-strike records the later press. Existing tests still pass.
2. **Steady**: on-time chords → first chord `restart: 'first'`, the rest `deltaMs ≈ 0`, no pauses.
3. **Late within window**: one chord 30 % late → `deltaPct ≈ 30`, clock not moved. The next chord, played on the original grid, has `delta ≈ 0`.
4. **Pause**: 3 beats of silence before chord k → chord k `restart: 'pause'`. The following chords are timed from k's onset.
5. **Criterion changes classification**: a chord 40 % late is timed with `pauseBeats 0.5` and a pause with `0.3`.
6. **Drift is not forgiven**: every chord 15 % of a beat slower than the last. Deltas 15, 30, 45 %, then the 5th chord (60 %) is a pause and the 6th is back to 15 %.
7. **Early**: a chord 70 % early is timed (negative), never a pause.
8. **Per-note timing in a chord**: LH 40 ms before RH → chord onset = the LH time. Each note has its own `deltaMs`.
9. **Duration**: normal hold → `durationPct` from real ms. A key held through a pause → `durationPct` undefined. Key-ups after the last completion are used (the last chord's durations).
10. **Hands**: `hands: 'left'` reports only staff 2.
11. **Wrong key**: becomes an extra at the current chord's `onMs / speed`. A wrong key before the first chord is dropped.
12. **Stopped early**: only completed chords are reported.
13. **Pedal**: Ped. on time → `deltaMs ≈ 0` via the clock map. A pedal down during a pause → untimed, `restart: 'pause'`. A pedal held through a pause → real `heldMs`, `durationPct` undefined. A pedal before the first chord reads as early.
14. **Unison**: both hands on one pitch → both events get the same press.
15. **Re-struck key**: timed from the press that completed the chord.
16. **A hand found late**: not a pause, the late hand reads late (see open questions).
17. **Bpm**: the same recording at a slower `speed` gives later expected times and different pauses.

Run `npm test` and `npm run build` (tsc must pass).

## Step 7: README

Add a **Follow mode** paragraph between Wait and Tempo, covering:
- Plays like Wait.
- Clock at the set bpm, no metronome. −/+ during the review re-times the run.
- On time = the review criterion.
- A chord later than the match window (50 % at 20 %, 30 % at 10 %) is a pause: grey, and the clock restarts there.
- Drift is not forgiven, and no re-center.
- Latency calibration is not needed.
- The run ends when the last chord is let go.
- Same review as Tempo at the end, with N pauses in the summary.

## Manual test checklist (tablet / laptop + piano)

- [ ] Follow plays exactly like Wait: chord-at-once rule, red flash, greens, progress line, scrolling.
- [ ] Steady playing at the set bpm → mostly green in the Notes layer, 0 pauses.
- [ ] A deliberate stop to change position → that chord is grey, timing afterwards is sensible, 1 pause.
- [ ] Slowly dragging → amber/brown growing, then a pause.
- [ ] 10 % ↔ 20 % in the review recomputes the pauses.
- [ ] −/+ during the review re-times it. Save run then records the new bpm.
- [ ] The review appears when the last chord is let go. Its Duration is measured.
- [ ] Duration, Velocity and Pedal layers populated. A note held through a stop is grey on Duration. A pedal pressed during a stop is grey.
- [ ] Bars section and Left/Right work. Stop mid-way shows a partial review, and keys after it do nothing until Restart.
- [ ] Save run → JSON has `mode: "follow"`. `__replay(json.recording, json.speed, Infinity, 'follow')` reproduces the review.
- [ ] Wait and Tempo unchanged.

## Open questions for testing

Kept as planned for v1. Revisit with real runs.

- **Pause threshold = match window.** Objections raised in review:
  - Not monotonic: at ±10 %, a chord 25 % late gets ▸, one 35 % late is a pause and reads grey (neutral). The worse note looks better.
  - Changing the criterion moves the anchors, so the ms of every later note change. A display criterion changes the measurements.
  - Drift is forgiven in steps: dragging at ±10 % resets the clock about every 4 chords. The pause count is then the only sign of it.
  - Alternative: a fixed threshold (1 or 2 beats). Between the window and the threshold, a note clamps at full late colour with ▸, as early notes already do. The criterion then no longer changes the pauses.
  - Tested on the two Waltz in A minor runs of 2026-10-25 (50 bpm). A fixed threshold makes things worse: a hesitation that is no longer a pause leaves the clock behind, so every note after it reads late until the next pause. Complete run, ±20 %: window 249 within / 92 pauses; 1 beat 224 / 64; 2 beats 109 / 43. Notes beyond the colour range: 123 → 249 → 511. Kept the window.
  - Idea, untested: keep the window rule, but time the restart chord itself when it is less than 1 beat late (full late colour + ▸, the clock still restarts). Grey only for real stops of 1 beat or more. That fixes "later looks better" without the knock-on.
- **One-chord anchors.** Each stretch is timed from one chord. If that chord is 30 ms off the player's own pulse, every note after it shifts by 30 ms (6 % at 120 bpm). Seen in the Waltz in A minor run of 2026-10-25 17:57: bar 2 came 25 % early after the pickup, and that −25 % carried into every later note (on top of real rushing, about 52 bpm for 50).
  - Done 2026-10-25 (see "Bar-based start" in the rules): a bar-based start. After a stretch's first bar, move the clock once by the median offset of its chords (each chord = the median of its notes; the earliest note stays for the pause decision). The tempo stays fixed, so drift still builds up. The starting chord then gets a timing too. Only for stretches that go on past their first bar; shorter ones keep the grey start. On that run: shift −26 %, the pickup +26 %, bars 2–3 within ±20 %, bars 4–9 still early, bar 10 +41 %. Whole run at ±20 %: within 249 → 336, beyond the colour range 123 → 54, pauses unchanged (92). Watch: a stretch just over a bar long is mostly judged against its own bar.
- **A hand found late in an anchor chord.** The LH is on time, then the RH is found 2 beats later, with the LH held. The chord is not a pause (onset = the LH). The RH reads very late, and the next chord becomes a pause instead.
- **Fast passages crossing hands.** Wait asks for chords in strict order. If one hand's next note comes before the other hand's current one (hand spread longer than the note value), it is a wrong key and must be struck again. Probably rare. Check on a fast piece.

## Out of scope / later

- **Ritardando, accelerando and fermatas.** Tempo changes written as metronome marks are already in `onMs` and are followed automatically. An unmarked *rit.* will show as growing lateness and then a pause. A later option could be per-bar tempo hints, or tempo text from the score.
- Live timing colours (decided: not now).
- Several wrong keys on one chord: their × markers sit on one spot. Merge them into one marker listing the pitches, if it bothers.
