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

// The single shared "how much tissue loading is allowed" function. At
// gfNow=1 this equals the raw M-value; gfNow<1 shrinks the allowed
// supersaturation toward pAmb (gfNow=0 means no supersaturation at all).
// This is the one place gradient-factor math is defined — NDL, ceiling, and
// deco-stop-time all derive from it rather than reimplementing it.
export function getAllowedPressure(a, b, pAmb, gfNow) {
  return pAmb + gfNow * (mValue(pAmb, a, b) - pAmb);
}

// Algebraic inverse of getAllowedPressure, solved for pAmb: the ambient
// pressure at which this compartment's GF-adjusted allowed pressure would
// exactly equal its current tissue pressure. At gfNow=1 this reduces to the
// original raw ceiling formula (pTissue - a) * b.
function gfCeilingPressure(pTissue, a, b, gfNow) {
  return (pTissue - gfNow * a) / (1 - gfNow + gfNow / b);
}

// GF_now via linear interpolation between GF Low (at the first stop depth)
// and GF High (at the surface), based on where currentDepthMeters sits
// between them. No stop yet (firstStopDepthMeters <= 0) means GF High.
export function computeGFNow(currentDepthMeters, firstStopDepthMeters, gfLow, gfHigh) {
  if (firstStopDepthMeters <= 0) return gfHigh;
  const fraction = Math.min(1, Math.max(0, currentDepthMeters / firstStopDepthMeters));
  return gfHigh + fraction * (gfLow - gfHigh);
}

// Deepest (controlling) GF-adjusted ceiling as an ambient pressure (bar),
// plus which compartment controls. Two passes: GF Low alone determines
// whether a stop exists at all and how deep the first one is; GF_now
// (interpolated from that using currentDepthMeters) determines the actual
// controlling ceiling used everywhere else.
function maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh) {
  let firstStopPressure = -Infinity;
  for (let i = 0; i < pTissues.length; i++) {
    const { a, b } = COMPARTMENTS[i];
    const p = gfCeilingPressure(pTissues[i], a, b, gfLow);
    if (p > firstStopPressure) firstStopPressure = p;
  }
  const firstStopDepthMeters = Math.max(0, (firstStopPressure - 1) * 10);
  const gfNow = computeGFNow(currentDepthMeters, firstStopDepthMeters, gfLow, gfHigh);

  let maxCeilingP = -Infinity;
  let controllingCompartmentIndex = 0;
  for (let i = 0; i < pTissues.length; i++) {
    const { a, b } = COMPARTMENTS[i];
    const p = gfCeilingPressure(pTissues[i], a, b, gfNow);
    if (p > maxCeilingP) {
      maxCeilingP = p;
      controllingCompartmentIndex = i;
    }
  }
  return { maxCeilingP, controllingCompartmentIndex };
}

// Raw (unrounded) GF-adjusted ceiling depth in meters, clamped to 0.
export function ceilingDepth(pTissues, currentDepthMeters, gfLow, gfHigh) {
  const { maxCeilingP } = maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh);
  return Math.max(0, (maxCeilingP - 1) * 10);
}

// Minutes remaining at the current depth before any compartment's projected
// pressure would exceed its GF-Low-adjusted allowed pressure at the surface
// — GF_now for NDL purposes is always flat GF Low, since NDL is about when
// a ceiling first forms, not about an ascent already in progress. Returns
// Infinity if no violation occurs within maxMinutes (treat as "no limit").
export function computeNDL(pTissues, depthMeters, gfLow, maxMinutes = 999) {
  const pAmb = ambientPressureAtDepth(depthMeters);
  let tissues = pTissues.slice();

  for (let t = 0; t <= maxMinutes; t++) {
    for (let i = 0; i < tissues.length; i++) {
      const { a, b } = COMPARTMENTS[i];
      if (tissues[i] > getAllowedPressure(a, b, PAMB_0, gfLow)) {
        return t;
      }
    }
    tissues = stepCompartments(tissues, pAmb, 1);
  }
  return Infinity;
}

// The controlling (deepest) mandatory decompression stop across all
// compartments, rounded up to the next 3m increment — the depth actually
// displayed and enforced, as opposed to the raw unrounded `ceilingDepth`.
export function computeCeiling(pTissues, currentDepthMeters, gfLow, gfHigh) {
  const { maxCeilingP, controllingCompartmentIndex } =
    maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh);
  const rawDepth = Math.max(0, (maxCeilingP - 1) * 10);
  const ceilingDepth = rawDepth <= 0 ? 0 : Math.ceil(rawDepth / 3) * 3;
  return { ceilingDepth, controllingCompartmentIndex };
}

// Seconds the diver must remain at heldDepthMeters before computeCeiling
// would newly report a shallower rounded stop (0 if already clear to
// ascend further). GF_now is re-derived each step from the evolving tissue
// state, held at the constant heldDepthMeters. Steps forward in 1-second
// increments for precision.
export function computeDecoStopSeconds(pTissues, heldDepthMeters, gfLow, gfHigh, maxSeconds = 3600) {
  const pAmb = ambientPressureAtDepth(heldDepthMeters);
  let tissues = pTissues.slice();

  if (computeCeiling(tissues, heldDepthMeters, gfLow, gfHigh).ceilingDepth < heldDepthMeters) return 0;

  for (let s = 1; s <= maxSeconds; s++) {
    tissues = stepCompartments(tissues, pAmb, 1 / 60);
    if (computeCeiling(tissues, heldDepthMeters, gfLow, gfHigh).ceilingDepth < heldDepthMeters) return s;
  }
  return maxSeconds;
}

// True if any compartment's tissue pressure exceeds its surface M-value —
// the final safety check at the moment the diver reaches 0m.
export function hasSurfacingViolation(pTissues) {
  return pTissues.some((pTissue, i) => {
    const { a, b } = COMPARTMENTS[i];
    return pTissue > mValue(PAMB_0, a, b);
  });
}
