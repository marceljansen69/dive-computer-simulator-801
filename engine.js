// Bühlmann ZH-L16B decompression engine.
// Pure functions only: no DOM access, no globals besides these exports.
// Nitrogen-only model. Constants per CLAUDE.md — do not alter without explicit request.

export const COMPARTMENTS = [
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
];

// bar per 10m of seawater, 1 bar at the surface.
export function ambientPressureAtDepth(depthMeters) {
  return 1 + depthMeters / 10;
}

// Reference ambient pressure used for "surface" M-value comparisons.
// Currently fixed at 0.79 bar (allowable N2 load at sea level on air).
// Will later vary with the altitude selector once that's wired up.
export const PAMB_0 = 0.79;

// Surface equilibrium N2 pressure for a given O2 fraction (nitrox %) at 1 bar.
// nitroxPercent is accepted for forward-compatibility but callers currently
// always pass 21 (air) — nitrox is not yet wired into the calculations.
export function createCompartments(nitroxPercent = 21) {
  const n2Fraction = 1 - nitroxPercent / 100;
  const pN2Surface = 1 * n2Fraction;
  return COMPARTMENTS.map(() => pN2Surface);
}

// Haldane equation: one compartment, one timestep.
export function haldaneStep(pOld, pAmb, halfTime, minutes) {
  const k = Math.log(2) / halfTime;
  return pAmb + (pOld - pAmb) * Math.exp(-k * minutes);
}

// Advance every compartment by `minutes` at constant ambient pressure `pAmb`.
export function stepCompartments(pTissues, pAmb, minutes) {
  return pTissues.map((p, i) => haldaneStep(p, pAmb, COMPARTMENTS[i].halfTime, minutes));
}

export function mValue(pAmb, a, b) {
  return a + pAmb / b;
}

// Ceiling ambient pressure (bar) above which this compartment would be supersaturated.
export function ceilingPressure(pTissue, a, b) {
  return (pTissue - a) * b;
}

// Deepest ceiling across all compartments, expressed as ambient pressure (bar).
export function maxCeilingPressure(pTissues) {
  let max = -Infinity;
  for (let i = 0; i < pTissues.length; i++) {
    const { a, b } = COMPARTMENTS[i];
    const p = ceilingPressure(pTissues[i], a, b);
    if (p > max) max = p;
  }
  return max;
}

// Ceiling as a depth in meters, clamped to 0 (surface) when no stop is required.
export function ceilingDepth(pTissues) {
  const p = maxCeilingPressure(pTissues);
  return Math.max(0, (p - 1) * 10);
}

// Minutes remaining at the current depth before any compartment's projected
// pressure would exceed its surface M-value. Returns Infinity if no violation
// occurs within maxMinutes (treat as "no limit" in the UI).
export function computeNDL(pTissues, depthMeters, maxMinutes = 999) {
  const pAmb = ambientPressureAtDepth(depthMeters);
  let tissues = pTissues.slice();

  for (let t = 0; t <= maxMinutes; t++) {
    for (let i = 0; i < tissues.length; i++) {
      const { a, b } = COMPARTMENTS[i];
      if (tissues[i] > mValue(PAMB_0, a, b)) {
        return t;
      }
    }
    tissues = stepCompartments(tissues, pAmb, 1);
  }
  return Infinity;
}
