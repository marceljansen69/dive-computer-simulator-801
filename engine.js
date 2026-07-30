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

// Standard atmosphere approximation, valid for recreational dive altitudes.
// altitudeMeters=0 gives exactly 1 bar.
export function surfacePressureAtAltitude(altitudeMeters) {
  return Math.pow(1 - 2.25577e-5 * altitudeMeters, 5.25588);
}

// Fraction of inert gas (nitrogen) in the breathing mix.
export function n2Fraction(nitroxPercent) {
  return 1 - nitroxPercent / 100;
}

// The partial pressure that actually drives tissue loading (the Haldane
// equation's "P_amb") is the inert-gas share of ambient pressure, not the
// total. This is the one place that distinction is made — every caller that
// steps tissue loading should pass this, not a raw ambient pressure.
export function inspiredInertGasPressure(ambientPressure, nitroxPercent) {
  return ambientPressure * n2Fraction(nitroxPercent);
}

// bar per 10m of seawater, surfacePressureAtAltitude(altitudeMeters) at the
// surface (1 bar at sea level).
export function ambientPressureAtDepth(depthMeters, altitudeMeters = 0) {
  return surfacePressureAtAltitude(altitudeMeters) + depthMeters / 10;
}

// Reference ambient pressure used for "surface" M-value comparisons at sea
// level on air — exactly inspiredInertGasPressure(surfacePressureAtAltitude(0), 21).
// Kept as a constant for backward compatibility; computeNDL/hasSurfacingViolation
// now compute the equivalent value fresh from whatever nitrox/altitude is
// passed in, rather than using this directly.
export const PAMB_0 = 0.79;

// Haldane equation: one compartment, one timestep.
export function haldaneStep(pOld, pAmb, halfTime, minutes) {
  const k = Math.log(2) / halfTime;
  return pAmb + (pOld - pAmb) * Math.exp(-k * minutes);
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

// Builds the compartment-dependent half of the engine's API for a specific
// compartment table (and ceiling-rounding convention) — everything above
// this point is already parameter-only and needs no per-computer wiring.
// This is how a different "dive computer" (a different half-time/a/b table,
// or a different rounding increment) gets simulated: call createEngine with
// its table instead of the default COMPARTMENTS, and use the returned
// functions in place of these — the math inside each function is identical
// to before, only the compartment table/rounding it closes over changes.
export function createEngine(compartments, ceilingRoundingMeters = 3) {
  // Surface equilibrium N2 pressure for a given O2 fraction (nitrox %) and
  // altitude at t=0.
  function createCompartments(nitroxPercent = 21, altitudeMeters = 0) {
    const pN2Surface = inspiredInertGasPressure(surfacePressureAtAltitude(altitudeMeters), nitroxPercent);
    return compartments.map(() => pN2Surface);
  }

  // Advance every compartment by `minutes` at constant ambient pressure `pAmb`.
  function stepCompartments(pTissues, pAmb, minutes) {
    return pTissues.map((p, i) => haldaneStep(p, pAmb, compartments[i].halfTime, minutes));
  }

  // Deepest (controlling) GF-adjusted ceiling as an ambient pressure (bar),
  // plus which compartment controls. Two passes: GF Low alone determines
  // whether a stop exists at all and how deep the first one is; GF_now
  // (interpolated from that using currentDepthMeters) determines the actual
  // controlling ceiling used everywhere else. altitudeMeters only affects
  // the pressure<->depth conversion (the local surface baseline) — nitrox
  // isn't needed here since tissue pressures already reflect it from
  // however they were loaded.
  //
  // TEMPORARY DIAGNOSTIC: pass a truthy `debugLabel` to log the full
  // per-compartment breakdown for this call. Not wired to anything by
  // default — only call sites that pass a label produce output.
  function maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh, altitudeMeters = 0, debugLabel) {
    const surfacePressure = surfacePressureAtAltitude(altitudeMeters);
    let firstStopPressure = -Infinity;
    const pass1 = [];
    for (let i = 0; i < pTissues.length; i++) {
      const { a, b } = compartments[i];
      const p = gfCeilingPressure(pTissues[i], a, b, gfLow);
      pass1.push(Math.max(0, (p - surfacePressure) * 10));
      if (p > firstStopPressure) firstStopPressure = p;
    }
    const firstStopDepthMeters = Math.max(0, (firstStopPressure - surfacePressure) * 10);
    const gfNow = computeGFNow(currentDepthMeters, firstStopDepthMeters, gfLow, gfHigh);

    let maxCeilingP = -Infinity;
    let controllingCompartmentIndex = 0;
    const pass2 = [];
    for (let i = 0; i < pTissues.length; i++) {
      const { a, b } = compartments[i];
      const p = gfCeilingPressure(pTissues[i], a, b, gfNow);
      pass2.push(Math.max(0, (p - surfacePressure) * 10));
      if (p > maxCeilingP) {
        maxCeilingP = p;
        controllingCompartmentIndex = i;
      }
    }

    if (debugLabel) {
      const roundedEach = pass2.map((d) => (d <= 0 ? 0 : Math.ceil(d / ceilingRoundingMeters) * ceilingRoundingMeters));
      const maxPass2 = Math.max(...pass2);
      console.log(
        `[deco-debug] ${debugLabel} | currentDepth=${currentDepthMeters.toFixed(2)}m ` +
        `gfLow=${gfLow} gfHigh=${gfHigh}`
      );
      console.log(
        '  pass1 (flat GF_low) ceiling depth per compartment (1-16):',
        pass1.map((d) => d.toFixed(2)).join(', ')
      );
      console.log(
        `  firstStopDepthMeters=${firstStopDepthMeters.toFixed(2)}  gfNow=${gfNow.toFixed(4)}`
      );
      console.log(
        '  pass2 (GF_now) ceiling depth per compartment (1-16):',
        pass2.map((d) => d.toFixed(2)).join(', ')
      );
      console.log(
        `  pass2 rounded (${ceilingRoundingMeters}m) per compartment (1-16):`,
        roundedEach.join(', ')
      );
      console.log(
        `  controllingCompartmentIndex=${controllingCompartmentIndex} (compartment #${controllingCompartmentIndex + 1}), ` +
        `its depth=${pass2[controllingCompartmentIndex].toFixed(2)}m, max-of-all=${maxPass2.toFixed(2)}m, ` +
        `isActualMax=${Math.abs(pass2[controllingCompartmentIndex] - maxPass2) < 1e-9}`
      );
    }

    return { maxCeilingP, controllingCompartmentIndex };
  }

  // Raw (unrounded) GF-adjusted ceiling depth in meters, clamped to 0.
  function ceilingDepth(pTissues, currentDepthMeters, gfLow, gfHigh, altitudeMeters = 0, debugLabel) {
    const { maxCeilingP } = maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh, altitudeMeters, debugLabel);
    return Math.max(0, (maxCeilingP - surfacePressureAtAltitude(altitudeMeters)) * 10);
  }

  // Minutes remaining at the current depth before any compartment's
  // projected pressure would exceed its GF-Low-adjusted allowed pressure at
  // the surface — GF_now for NDL purposes is always flat GF Low, since NDL
  // is about when a ceiling first forms, not about an ascent already in
  // progress. Returns Infinity if no violation occurs within maxMinutes
  // (treat as "no limit").
  //
  // The M-value threshold is a function of TOTAL ambient pressure, not the
  // breathing gas's inert-gas fraction — nitrox only changes how fast
  // tissues load (via inspiredInertGasPressure), never the threshold
  // itself. altitude still shifts the surface reference; nitrox must not.
  function computeNDL(pTissues, depthMeters, gfLow, nitroxPercent = 21, altitudeMeters = 0, maxMinutes = 999) {
    const pAmb = ambientPressureAtDepth(depthMeters, altitudeMeters);
    const inspiredPressure = inspiredInertGasPressure(pAmb, nitroxPercent);
    const surfaceReference = surfacePressureAtAltitude(altitudeMeters);
    let tissues = pTissues.slice();

    for (let t = 0; t <= maxMinutes; t++) {
      for (let i = 0; i < tissues.length; i++) {
        const { a, b } = compartments[i];
        if (tissues[i] > getAllowedPressure(a, b, surfaceReference, gfLow)) {
          return t;
        }
      }
      tissues = stepCompartments(tissues, inspiredPressure, 1);
    }
    return Infinity;
  }

  // The controlling (deepest) mandatory decompression stop across all
  // compartments, rounded up to the next ceilingRoundingMeters increment —
  // the depth actually displayed and enforced, as opposed to the raw
  // unrounded `ceilingDepth`.
  function computeCeiling(pTissues, currentDepthMeters, gfLow, gfHigh, altitudeMeters = 0, debugLabel) {
    const { maxCeilingP, controllingCompartmentIndex } =
      maxCeilingPressureWithGF(pTissues, currentDepthMeters, gfLow, gfHigh, altitudeMeters, debugLabel);
    const rawDepth = Math.max(0, (maxCeilingP - surfacePressureAtAltitude(altitudeMeters)) * 10);
    const ceilingDepthRounded = rawDepth <= 0 ? 0 : Math.ceil(rawDepth / ceilingRoundingMeters) * ceilingRoundingMeters;
    if (debugLabel) {
      console.log(`  => rounded controlling ceiling = ${ceilingDepthRounded}m (raw ${rawDepth.toFixed(2)}m)`);
    }
    return { ceilingDepth: ceilingDepthRounded, controllingCompartmentIndex };
  }

  // Seconds the diver must remain at heldDepthMeters before computeCeiling
  // would newly report a shallower rounded stop (0 if already clear to
  // ascend further). GF_now is re-derived each step from the evolving
  // tissue state, held at the constant heldDepthMeters. Steps forward in
  // 1-second increments for precision.
  function computeDecoStopSeconds(pTissues, heldDepthMeters, gfLow, gfHigh, nitroxPercent = 21, altitudeMeters = 0, maxSeconds = 3600) {
    const pAmb = ambientPressureAtDepth(heldDepthMeters, altitudeMeters);
    const inspiredPressure = inspiredInertGasPressure(pAmb, nitroxPercent);
    let tissues = pTissues.slice();

    if (computeCeiling(tissues, heldDepthMeters, gfLow, gfHigh, altitudeMeters).ceilingDepth < heldDepthMeters) return 0;

    for (let s = 1; s <= maxSeconds; s++) {
      tissues = stepCompartments(tissues, inspiredPressure, 1 / 60);
      if (computeCeiling(tissues, heldDepthMeters, gfLow, gfHigh, altitudeMeters).ceilingDepth < heldDepthMeters) return s;
    }
    return maxSeconds;
  }

  // True if any compartment's tissue pressure exceeds its surface M-value —
  // the final safety check at the moment the diver reaches 0m. The
  // threshold is total ambient pressure at the surface, not nitrox-scaled —
  // see computeNDL's comment for why.
  function hasSurfacingViolation(pTissues, altitudeMeters = 0) {
    const surfaceReference = surfacePressureAtAltitude(altitudeMeters);
    return pTissues.some((pTissue, i) => {
      const { a, b } = compartments[i];
      return pTissue > mValue(surfaceReference, a, b);
    });
  }

  return {
    createCompartments,
    stepCompartments,
    computeNDL,
    computeCeiling,
    ceilingDepth,
    computeDecoStopSeconds,
    hasSurfacingViolation,
  };
}
