// Sanity checks for engine.js. Run with: node engine.test.mjs
// (Same functions can be pasted/imported into a browser console — engine.js
// has no DOM dependency.)

import {
  createCompartments,
  stepCompartments,
  ambientPressureAtDepth,
  mValue,
  getAllowedPressure,
  computeGFNow,
  computeNDL,
  ceilingDepth,
  computeCeiling,
  computeDecoStopSeconds,
  hasSurfacingViolation,
} from './engine.js';

// GF 100/100 is not a selectable preset in the UI, but it's the reference
// point that proves the GF refactor is a strict generalization: every test
// below that predates gradient factors now passes gfLow=gfHigh=1 and keeps
// its original expected numbers unchanged.
const GF_100 = 1;

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

// 1. A compartment's tissue pressure approaches ambient pressure asymptotically
//    at constant depth and never overshoots it.
{
  let tissues = createCompartments(21);
  const depth = 30; // meters, constant
  const pAmb = ambientPressureAtDepth(depth);
  const startingSide = tissues.map((p) => Math.sign(pAmb - p)); // ambient > tissue for a descent
  let prevDistance = tissues.map((p) => Math.abs(pAmb - p));
  let overshot = false;
  let neverGetsCloser = false;

  // The slowest compartment has a 635-minute half-time; run long enough
  // (~20 half-lives) for it to converge within the tolerance below.
  const totalMinutes = 20 * 635;
  for (let minute = 0; minute < totalMinutes; minute++) {
    tissues = stepCompartments(tissues, pAmb, 1);
    const distance = tissues.map((p) => Math.abs(pAmb - p));
    for (let i = 0; i < tissues.length; i++) {
      const currentSide = Math.sign(pAmb - tissues[i]);
      if (currentSide !== 0 && currentSide !== startingSide[i]) overshot = true;
      if (distance[i] > prevDistance[i] + 1e-9) neverGetsCloser = true;
    }
    prevDistance = distance;
  }

  const closeToAmbient = tissues.every((p) => Math.abs(p - pAmb) < 1e-5);
  check(
    'compartments approach ambient pressure asymptotically without overshoot',
    closeToAmbient && !neverGetsCloser && !overshot
  );
}

// 2. NDL should be 0 immediately upon reaching a very deep depth on air after
//    enough bottom time (tissues already loaded well past the M-value).
{
  let tissues = createCompartments(21);
  const deepDepth = 60; // meters
  const pAmbDeep = ambientPressureAtDepth(deepDepth);
  // Saturate compartments at depth for a very long time (fully equilibrated).
  tissues = stepCompartments(tissues, pAmbDeep, 3000);
  const ndl = computeNDL(tissues, deepDepth, GF_100);
  check('NDL is 0 after long bottom time at a deep depth on air', ndl === 0);
}

// 3. Ceiling is 0 (surface) for a short, shallow dive.
{
  let tissues = createCompartments(21);
  const shallowDepth = 10; // meters
  const pAmbShallow = ambientPressureAtDepth(shallowDepth);
  tissues = stepCompartments(tissues, pAmbShallow, 10); // 10 minutes at 10m
  const ceiling = ceilingDepth(tissues, shallowDepth, GF_100, GF_100);
  check('ceiling is 0 for a short shallow dive', ceiling === 0);
}

// 4. computeCeiling is 0 for a tissue state well within all M-values.
{
  const tissues = createCompartments(21);
  const { ceilingDepth: ceiling } = computeCeiling(tissues, 0, GF_100, GF_100);
  check('computeCeiling is 0 for a tissue state well within M-values', ceiling === 0);
}

// 5. computeCeiling rounds up to the correct 3m increment for known,
//    fully-saturated tissue states (closed-form: ceilingPressure = (pAmb - a) * b).
//    Compartment 16 (index 15) has the smallest `a` and largest `b`, so it
//    controls once fully saturated at any of these depths.
{
  // 20m -> pAmb 3.0 bar -> raw ceiling ~16.38m -> rounds up to 18m.
  let tissues = createCompartments(21);
  tissues = stepCompartments(tissues, ambientPressureAtDepth(20), 20 * 635);
  const result = computeCeiling(tissues, 20, GF_100, GF_100);
  check('computeCeiling rounds 16.38m up to 18m at 20m saturation', result.ceilingDepth === 18);
  check('computeCeiling identifies compartment 16 as controlling at 20m saturation',
    result.controllingCompartmentIndex === 15);
}
{
  // 15m -> pAmb 2.5 bar -> raw ceiling ~11.58m -> rounds up to 12m.
  let tissues = createCompartments(21);
  tissues = stepCompartments(tissues, ambientPressureAtDepth(15), 20 * 635);
  const result = computeCeiling(tissues, 15, GF_100, GF_100);
  check('computeCeiling rounds 11.58m up to 12m at 15m saturation', result.ceilingDepth === 12);
}
{
  // 30m -> pAmb 4.0 bar -> raw ceiling ~25.99m -> rounds up to 27m.
  let tissues = createCompartments(21);
  tissues = stepCompartments(tissues, ambientPressureAtDepth(30), 20 * 635);
  const result = computeCeiling(tissues, 30, GF_100, GF_100);
  check('computeCeiling rounds 25.99m up to 27m at 30m saturation', result.ceilingDepth === 27);
}

// 6. computeDecoStopSeconds decreases as held time increases, and reaches
//    exactly 0 (via computeCeiling reporting a shallower value) at the
//    moment the calculated time elapses — not before, not after.
{
  let tissues = createCompartments(21);
  tissues = stepCompartments(tissues, ambientPressureAtDepth(30), 20); // real bottom time, not saturated
  const { ceilingDepth: stopDepth } = computeCeiling(tissues, 30, GF_100, GF_100);
  const secondsRemaining = computeDecoStopSeconds(tissues, stopDepth, GF_100, GF_100);
  check('deco stop time is positive when a stop is required', secondsRemaining > 0);

  const pAmbStop = ambientPressureAtDepth(stopDepth);
  const tissuesJustBefore = stepCompartments(tissues, pAmbStop, (secondsRemaining - 1) / 60);
  check(
    'ceiling has not yet cleared one second before the stop time elapses',
    computeCeiling(tissuesJustBefore, stopDepth, GF_100, GF_100).ceilingDepth === stopDepth
  );

  const tissuesAtClear = stepCompartments(tissues, pAmbStop, secondsRemaining / 60);
  check(
    'ceiling clears to a shallower value exactly when the stop time elapses',
    computeCeiling(tissuesAtClear, stopDepth, GF_100, GF_100).ceilingDepth < stopDepth
  );

  const secondsRemainingLater = computeDecoStopSeconds(tissuesJustBefore, stopDepth, GF_100, GF_100);
  check('deco stop time decreases as held time increases', secondsRemainingLater < secondsRemaining);
}

// 7. hasSurfacingViolation flags tissues above the surface M-value and
//    passes tissues within it.
{
  let violatingTissues = createCompartments(21);
  violatingTissues = stepCompartments(violatingTissues, ambientPressureAtDepth(60), 3000);
  check(
    'hasSurfacingViolation flags a tissue state above the surface M-value',
    hasSurfacingViolation(violatingTissues)
  );

  const safeTissues = createCompartments(21);
  check(
    'hasSurfacingViolation passes a tissue state within the surface M-value',
    !hasSurfacingViolation(safeTissues)
  );
}

// 8. getAllowedPressure sanity: at gf=1 it's the raw M-value; at gf=0 no
//    supersaturation at all is allowed (allowed pressure equals ambient).
{
  const { a, b } = { a: 0.7562, b: 0.7825 }; // compartment 5
  const pAmb = 3;
  check(
    'getAllowedPressure at gf=1 equals the raw M-value',
    Math.abs(getAllowedPressure(a, b, pAmb, 1) - mValue(pAmb, a, b)) < 1e-9
  );
  check(
    'getAllowedPressure at gf=0 equals ambient pressure (no supersaturation allowed)',
    Math.abs(getAllowedPressure(a, b, pAmb, 0) - pAmb) < 1e-9
  );
}

// 9. computeGFNow interpolates between GF Low (at the first stop depth) and
//    GF High (at the surface), and falls back to GF High when there's no
//    stop yet.
{
  const gfLow = 0.45, gfHigh = 0.95;
  const firstStopDepth = 12;
  check(
    'computeGFNow is GF Low at the first stop depth',
    Math.abs(computeGFNow(firstStopDepth, firstStopDepth, gfLow, gfHigh) - gfLow) < 1e-9
  );
  check(
    'computeGFNow is GF High at the surface',
    Math.abs(computeGFNow(0, firstStopDepth, gfLow, gfHigh) - gfHigh) < 1e-9
  );
  check(
    'computeGFNow is GF High when no stop exists yet',
    Math.abs(computeGFNow(20, 0, gfLow, gfHigh) - gfHigh) < 1e-9
  );
}

// 10. At GF 45/95 (default), NDL for a given depth/time is shorter than or
//     equal to the GF 100/100 (raw M-value) NDL for the same profile —
//     gradient factors should only ever make the sim more conservative.
{
  let tissues = createCompartments(21);
  const depth = 25;
  tissues = stepCompartments(tissues, ambientPressureAtDepth(depth), 15);
  const ndlRaw = computeNDL(tissues, depth, GF_100);
  const ndlGF45 = computeNDL(tissues, depth, 0.45);
  check('NDL at GF 45/95 is never longer than at GF 100/100', ndlGF45 <= ndlRaw);
}

// 11. At GF 35/75, ceiling depth for a given tissue state is equal to or
//     deeper than at GF 45/95 for the same state — more conservative
//     settings should never produce a shallower ceiling.
{
  let tissues = createCompartments(21);
  const depth = 30;
  tissues = stepCompartments(tissues, ambientPressureAtDepth(depth), 20);
  const ceilingGF45 = computeCeiling(tissues, depth, 0.45, 0.95).ceilingDepth;
  const ceilingGF35 = computeCeiling(tissues, depth, 0.35, 0.75).ceilingDepth;
  check('ceiling at GF 35/75 is never shallower than at GF 45/95', ceilingGF35 >= ceilingGF45);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
