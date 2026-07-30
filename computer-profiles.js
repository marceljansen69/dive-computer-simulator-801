// Dive computer "brand" parameter files. Each exported object bundles every
// input value the simulator feeds into engine.js/ui.js — swap which one
// ACTIVE_COMPUTER points to (below) to simulate a different computer.
// The decompression math itself (engine.js) never changes; only the
// numbers fed into it do.

export const GENERIC_ZHL16B = {
  name: 'Generic ZHL-16B',

  // Bühlmann ZH-L16B half-times (min) and a/b coefficients, 16 compartments.
  compartments: [
    { halfTime: 5.0,   a: 1.2599, b: 0.5050 },
    { halfTime: 8.0,   a: 1.1696, b: 0.5578 },
    { halfTime: 12.5,  a: 1.0000, b: 0.6514 },
    { halfTime: 18.5,  a: 0.8618, b: 0.7222 },
    { halfTime: 27.0,  a: 0.7562, b: 0.7825 },
    { halfTime: 38.3,  a: 0.6667, b: 0.8126 },
    { halfTime: 54.3,  a: 0.5933, b: 0.8434 },
    { halfTime: 77.0,  a: 0.5282, b: 0.8693 },
    { halfTime: 109.0, a: 0.4701, b: 0.8910 },
    { halfTime: 146.0, a: 0.4187, b: 0.9092 },
    { halfTime: 187.0, a: 0.3798, b: 0.9222 },
    { halfTime: 239.0, a: 0.3497, b: 0.9319 },
    { halfTime: 305.0, a: 0.3223, b: 0.9403 },
    { halfTime: 390.0, a: 0.2971, b: 0.9477 },
    { halfTime: 498.0, a: 0.2737, b: 0.9544 },
    { halfTime: 635.0, a: 0.2523, b: 0.9602 },
  ],

  // Mandatory-stop depths are rounded UP to the next multiple of this.
  ceilingRoundingMeters: 3,

  // Gradient factor presets (Low/High %, as shown to the user) and which
  // one is selected by default. Bar count increases with conservatism.
  gfPresets: [
    { low: 45, high: 95, bars: 1 }, // low conservatism — default
    { low: 40, high: 85, bars: 2 }, // medium conservatism
    { low: 35, high: 75, bars: 3 }, // high conservatism
  ],
  defaultGfIndex: 0,

  // NDL warning pause fires once NDL drops below this many minutes.
  ndlWarningMinutes: 3,

  // Advisory (non-enforced) safety stop: armed once the diver has been
  // deeper than zoneDepth, then counts down `seconds` while at/above it.
  safetyStop: { zoneDepth: 6, seconds: 180 },

  // Ascent-rate bar: level N (1..tierUpperBounds.length) lights when the
  // rate is below tierUpperBounds[N-1]; at/above the last entry is the top
  // tier. warningThreshold (m/min) is the separate cutoff for the
  // "Ascent rate exceeded" log entry — intentionally independent of the
  // bar's own top tier.
  ascentRate: { tierUpperBounds: [4, 5, 6, 7, 8, 9, 10], warningThreshold: 9 },

  // Selectable nitrox range (%) and the value selected by default.
  nitrox: { min: 21, max: 50, default: 21 },

  // Selectable altitude presets (m).
  altitudePresets: [0, 1500, 3000],
};

// The profile the app actually runs with. Point this at a different
// exported profile above (or a new one) to simulate a different computer.
export const ACTIVE_COMPUTER = GENERIC_ZHL16B;
