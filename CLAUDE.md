# Dive Computer Simulator — Project Conventions

## What this project is
A browser-based dive computer simulator. Single-page app, plain HTML/CSS/JS
(no framework unless we've explicitly decided to add one). Simulates a
recreational dive using the Bühlmann ZH-L16B algorithm, nitrogen only, with
a live "computer display," a draggable dive profile graph, and 16
compartment loading bars. Built iteratively — features are added in small,
testable increments across multiple sessions.

## Architecture rules
- **The decompression engine must stay pure.** All Bühlmann math (tissue
  loading, M-values, ceilings, NDL) lives in its own module (e.g.
  `engine.js`) as pure functions: no DOM access, no `document.*`, no
  event listeners. It should be testable by calling functions with plain
  numbers in and getting plain numbers out.
- **UI code stays separate from engine code.** Rendering, event handling,
  and DOM updates live in their own file(s) (e.g. `ui.js`). If a change
  is "fix the math," it belongs in the engine file. If it's "fix what's
  on screen," it belongs in the UI file. Don't let one leak into the other.
- Keep the project to a small number of files unless there's a clear
  reason to split further. Don't create new files/modules speculatively.

## Before writing code
- For any nontrivial change (new feature, structural change, anything
  touching more than one file), state a short plan first: which files
  will change, which functions will be added or modified. Wait for a
  go-ahead on anything that touches the engine's math.
- Before adding a new feature, check whether it fits the existing
  structure of the relevant file or whether that file should be
  refactored first. Prefer generalizing existing code over bolting a
  near-duplicate function on next to it.

## After writing code
- Run the app (or the relevant test) and verify it actually works before
  reporting the task as done. Don't assume correctness from reading the
  code alone, especially for anything involving the decompression math.
- Run the full test suite (see Testing below) before considering a change
  complete. If a change touches the engine, confirm existing tests still
  pass, not just the new one.
- Commit with a message that explains *why*, not just *what* (e.g.
  "Add GF-adjusted ceiling calc so shallow stops respect GF High" rather
  than "update engine.js").

## Testing
- Every engine function that affects safety-relevant output (tissue
  loading, ceiling, NDL, M-values) should have at least one sanity-check
  test. Add the test in the same session as the feature, not later.
- Baseline sanity checks to maintain as the project grows:
  - A compartment's tissue pressure approaches ambient pressure
    asymptotically at constant depth and never overshoots it.
  - NDL is 0 immediately upon reaching a sufficiently deep depth on air
    after enough bottom time.
  - Ceiling is 0 (surface) for a short, shallow dive.
- If a bug is fixed, add a test that would have caught it, when practical.

## Decompression constants (reference — do not alter without explicit request)
ZH-L16B, nitrogen only. Half-times (min), a, b per compartment:

| # | half-time | a | b |
|---|---|---|---|
| 1 | 5.0 | 1.2599 | 0.5050 |
| 2 | 8.0 | 1.1696 | 0.5578 |
| 3 | 12.5 | 1.0000 | 0.6514 |
| 4 | 18.5 | 0.8618 | 0.7222 |
| 5 | 27.0 | 0.7562 | 0.7825 |
| 6 | 38.3 | 0.6667 | 0.8126 |
| 7 | 54.3 | 0.5933 | 0.8434 |
| 8 | 77.0 | 0.5282 | 0.8693 |
| 9 | 109.0 | 0.4701 | 0.8910 |
| 10 | 146.0 | 0.4187 | 0.9092 |
| 11 | 187.0 | 0.3798 | 0.9222 |
| 12 | 239.0 | 0.3497 | 0.9319 |
| 13 | 305.0 | 0.3223 | 0.9403 |
| 14 | 390.0 | 0.2971 | 0.9477 |
| 15 | 498.0 | 0.2737 | 0.9544 |
| 16 | 635.0 | 0.2523 | 0.9602 |

Haldane equation: `P_new = P_amb + (P_old - P_amb) * e^(-k*t)`, `k = ln(2)/half-time`
M-value: `M = a + P_amb/b`
Ceiling: `ceiling_pressure = (P_tissue - a) * b`

If any of these constants look like they've drifted during a refactor,
flag it rather than silently "fixing" it — cross-check against this table.

## Style
- Naming: [fill in — e.g. camelCase for functions/variables, one function
  per logical step, descriptive names over comments explaining what a
  short name should have said]
- Comments: explain *why*, not *what*, for anything non-obvious
  (e.g. why a formula uses a particular constant or edge case), skip
  restating what the code already says.
- Prefer small, single-purpose functions over long ones, particularly in
  the engine module where each function should map to one formula or
  one clear step of the algorithm.

## Explicitly out of scope for now (don't build ahead)
- Gradient factor math is not yet wired into the ceiling calculation.
  GF buttons in the UI are placeholders until told otherwise.
- Altitude presets are UI placeholders only, not yet functional.
- No backend, no persistence beyond in-memory state, no build tooling
  unless explicitly requested.

## Periodic maintenance
- Every few feature additions, do a dedicated cleanup pass: read through
  the codebase for duplication, dead code, oversized files, or
  inconsistent naming, and propose changes before making them. This is
  a standalone task, not something to squeeze in alongside a feature.
