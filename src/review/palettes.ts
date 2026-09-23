// Colours and ranges for the review layers. Plain data: tune on the tablet, in
// daylight, here, not in the code that uses them.

export const NOTES = {
  played: '#16a34a',
  missed: '#dc2626',
};

// Layers 2–4: a missed note has no measurement. The same grey as the other
// hand and as notes after an early Stop (--muted-note): all simply not played.
export const NOT_MEASURED = '#c4c0bc';

// Every stop must read as a solid notehead on white paper, with no outline:
// nothing paler than about 2.2:1 contrast (amber). Near-white and pale yellow
// are out, even where the named scale they come from has them.

// Timing is signed, early → on time → late: dark blue → teal → green →
// yellow-green → amber → dark red. Green is on time (not isoluminant, on purpose:
// it is the one to look for). Stops are evenly spaced, so the ramp stays
// symmetric around green: yellow-green (so slightly late is not a muddy olive)
// is mirrored by teal on the early side.
export const TIMING_RAMP = ['#313695', '#3b7ec4', '#218f8d', '#1a9850', '#8db500', '#d08c00', '#b2182b'];
export const TIMING_LOG_KNEE = 5;                      // % where the log scale turns

// Duration, short → long: amber → deep purple, Inferno reversed and without its
// ends. Darker = longer, like velocity where darker = louder. It stops at deep
// purple, not black, so the longest notes never look like notes that were not
// reviewed (after an early Stop), and at amber rather than pale yellow.
export const DURATION_RAMP = [
  '#e8a200', '#f48c06', '#ed6925', '#cf4446', '#a52c60', '#781c6d', '#4a0c6b', '#2d0a55',
];
export const DURATION_RANGES = [100, 150, 200];        // % of the written length at full colour

// Velocity, soft → loud: teal → navy (YlGnBu without its pale end). Not green,
// which already means "on time" and "played".
export const VELOCITY_RAMP = ['#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'];

export const PEDAL_RING = '#0ea5e9';

// × beat, around the (re-centered) score time: how far off a key may be and
// still count as that note, and where the timing ramp reaches full colour.
export const MATCH_WINDOWS = [0.1, 0.2, 0.3, 0.4, 0.5];
