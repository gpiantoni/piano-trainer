// Colours and ranges for the review layers. Plain data: tune on the tablet, in
// daylight, here, not in the code that uses them.

// A missed note has no measurement. The same grey as the other hand and as
// notes after an early Stop (--muted-note): all simply not played.
export const NOT_MEASURED = '#c4c0bc';

// Every stop must read as a solid notehead on white paper, with no outline:
// nothing paler than about 2.2:1 contrast (amber). Near-white and pale yellow
// are out, even where the named scale they come from has them.

// One ramp for every layer, low → high: dark blue → teal → green → yellow-green
// → amber → dark orange-brown. Timing: early → on time → late; duration: short
// → long; velocity: soft → loud. Stops are evenly spaced, so the ramp stays
// symmetric around green: yellow-green (so slightly late is not a muddy olive)
// is mirrored by teal on the early side. No red: red means outside the timing
// criterion (the ◂ ▸ arrows) or a key not in the score (×).
export const RAMP = ['#313695', '#3b7ec4', '#218f8d', '#1a9850', '#8db500', '#d08c00', '#8c4a0a'];
export const TIMING_LOG_KNEE = 5;                      // % where the log scale turns

export const DURATION_RANGES = [100, 150, 200];        // % of the written length at full colour

// × beat, around the (re-centered) score time. `within`: the timing criterion,
// beyond it a note gets an early/late arrow and doesn't count as within in the
// summary. `window`: how far off a key may be and still count as that note,
// and where the timing ramp reaches full colour.
export const TIMING_CRITERIA = [{ within: 0.1, window: 0.3 }, { within: 0.2, window: 0.5 }];
// The re-center offset is measured at this window, before any criterion applies.
export const WIDEST_WINDOW = Math.max(...TIMING_CRITERIA.map((t) => t.window));
