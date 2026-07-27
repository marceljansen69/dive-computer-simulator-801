// Sanity checks for engine.js. Run with: node engine.test.mjs
// (Same functions can be pasted/imported into a browser console — engine.js
// has no DOM dependency.)

import {
  createCompartments,
  stepCompartments,
  ambientPressureAtDepth,
  computeNDL,
  ceilingDepth,
} from './engine.js';

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
  const ndl = computeNDL(tissues, deepDepth);
  check('NDL is 0 after long bottom time at a deep depth on air', ndl === 0);
}

// 3. Ceiling is 0 (surface) for a short, shallow dive.
{
  let tissues = createCompartments(21);
  const shallowDepth = 10; // meters
  const pAmbShallow = ambientPressureAtDepth(shallowDepth);
  tissues = stepCompartments(tissues, pAmbShallow, 10); // 10 minutes at 10m
  const ceiling = ceilingDepth(tissues);
  check('ceiling is 0 for a short shallow dive', ceiling === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
