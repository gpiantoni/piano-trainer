// Colours and ranges for the review layers. Plain data: tune on the tablet, in
// daylight, here, not in the code that uses them.

export const NOTES = {
  played: '#16a34a',
  missed: '#dc2626',
};

// Layers 2–4: a missed note has no measurement.
export const NOT_MEASURED = '#d6d3d1';

// Timing is signed: early and late fade out to plain black when on time.
export const TIMING = { early: '#2563eb', onTime: '#1c1917', late: '#ea580c' };
export const TIMING_RANGES = [10, 25, 50, 100, 300];   // ± % at which colour is full
export const TIMING_LOG_KNEE = 5;                      // % where the log scale turns

// Sequential ramps, short/soft → long/loud; both ends stay visible on white.
export const DURATION_RAMP = ['#ea580c', '#c026d3', '#6d28d9', '#1e1b4b'];
export const DURATION_RANGES = [100, 150, 200];        // % of the written length at full colour

export const VELOCITY_RAMP = ['#14b8a6', '#0284c7', '#4338ca', '#111827'];

export const PEDAL_RING = '#0ea5e9';

export const MATCH_WINDOWS = [0.5, 1, 2, 4];           // beats
