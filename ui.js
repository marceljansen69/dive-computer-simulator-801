// UI layer: rendering, DOM events, animation loop.
// All decompression math is delegated to engine.js — this file never
// computes tissue pressures itself.

import {
  COMPARTMENTS,
  createCompartments,
  stepCompartments,
  ambientPressureAtDepth,
  surfacePressureAtAltitude,
  inspiredInertGasPressure,
  mValue,
  computeNDL,
  ceilingDepth,
  computeCeiling,
  computeDecoStopSeconds,
  hasSurfacingViolation,
} from './engine.js';

const MSG_NDL_WARNING = "You're getting close to your limits, adjust the dive plan";
const MSG_CEILING_BREACH = 'Decompression stop required';
const MSG_DCS_RISK = 'You exceeded your limits and run an unacceptable risk of getting DCS';
const MSG_SAFETY_STOP_SKIPPED = "You surfaced before completing your 3-minute safety stop at 5m — it's a strongly recommended habit on every dive";
const LOCK_EPSILON = 1e-6;

// Safety stop: advisory only, unlike the mandatory decompression ceiling —
// real dive computers show a countdown but never force the diver to comply.
const SAFETY_STOP_ZONE_DEPTH = 6; // meters; shallower than this arms the reminder
const SAFETY_STOP_SECONDS = 180;  // 3 minutes

// DIAGNOSTIC FLAG — set true to log a full per-compartment ceiling
// breakdown (see engine.js's maxCeilingPressureWithGF) once per simulated
// minute, for investigating deco-stop-sequence issues. Must be false in
// normal use — leave off unless actively debugging.
const DEBUG_DECO = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  // Dive profile waypoints, sorted by time. {t: minutes, d: meters}
  waypoints: [
    { t: 0, d: 0 },
    { t: 5, d: 18 },
    { t: 25, d: 18 },
    { t: 30, d: 0 },
  ],
  maxTime: 60,   // graph horizontal scale, auto-grows
  maxDepth: 40,  // graph vertical scale, auto-grows

  nitroxPercent: 21,           // UI-only for now; engine always runs on air
  altitudeIndex: 0,            // 0 / 1 / 2 -> 0m / 1500m / 3000m, placeholder only
  gfIndex: 0,                  // 0 / 1 / 2 -> GF_PRESETS below; wired into the engine

  simRunning: false,
  simSpeed: 1,
  simStartReal: 0,       // performance.now() at (re)start
  simElapsedAtStart: 0,  // simulated minutes already elapsed when (re)started
  lastWholeMinute: -1,   // last integer minute the engine has processed
  simElapsedMinutes: 0,

  tissues: createCompartments(),
  ndl: Infinity,
  rafId: null,

  dragIndex: null,
  dragMoved: false,

  pauseReason: null,       // null | 'manual' | 'ndl-warning' | 'ceiling-breach'
  ndlWarningShown: false,  // the ndl-warning pause fires at most once per dive run
  diveFinished: false,     // true only once finishDive() has actually run

  ceilingDepthRounded: 0,      // displayed/enforced stop depth, rounded up to 3m
  decoStopSecondsRemaining: 0, // time left at the current held depth before ascent is allowed
  previousCeiling: 0,          // unrounded ceilingDepth() from the prior whole-minute check
  errorTriggered: false,       // sticky: a stop was left early, or the diver surfaced unsafely
  errorTriggeredAtMinute: null, // when ERROR first fired, for accurate replay of past instants

  hasDescendedPastSafetyZone: false, // armed once the diver has been deeper than SAFETY_STOP_ZONE_DEPTH
  safetyStopEnteredAtMinute: null,   // timestamp of the most recent continuous zone entry
  safetyStopSecondsRemaining: null,  // null when not in the zone; counts down from SAFETY_STOP_SECONDS

  previewTimeMinutes: null,    // non-null while scrubbing the timeline (paused-only, preview-only)
};

const ALTITUDE_PRESETS = [0, 1500, 3000];
// Matches Shearwater/Garmin convention: GF Low/GF High as percentages.
// Bar count increases with conservatism (fewer bars = less conservative).
const GF_PRESETS = [
  { low: 45, high: 95, bars: 1 }, // low conservatism — default
  { low: 40, high: 85, bars: 2 }, // medium conservatism
  { low: 35, high: 75, bars: 3 }, // high conservatism
];

// Current GF Low/High as 0..1 fractions, for engine calls.
function currentGF() {
  const preset = GF_PRESETS[state.gfIndex];
  return { low: preset.low / 100, high: preset.high / 100 };
}

// Current gas/altitude, for engine calls. Locked once a dive starts (see
// the arrow-button handlers below) — unlike GF, which stays live-adjustable.
function currentEnvironment() {
  return { nitroxPercent: state.nitroxPercent, altitudeMeters: ALTITUDE_PRESETS[state.altitudeIndex] };
}

// The depth fed into the engine's GF_now interpolation must never be
// shallower than the last known controlling ceiling. Without this, an
// ascent that overshoots a required stop within a single simulated minute
// (or a scrub/replay of one) makes GF_now relax toward GF High as if the
// diver were already safely shallow, producing an artificially shallow
// ceiling and a deco-stop-time that can never actually be satisfied from
// the real tissue load (root cause of the "jumps to a shallow stop with
// inflated time" bug, diagnosed against the 30m/25min test dive).
function gfAnchorDepth(actualDepth, previousCeiling) {
  return Math.max(actualDepth, previousCeiling);
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const profileCanvas = document.getElementById('profile-canvas');
const profileCtx = profileCanvas.getContext('2d');

const depthValueEl = document.getElementById('depth-value');
const timeValueEl = document.getElementById('time-value');
const ndlLabelEl = document.getElementById('ndl-label');
const ndlValueEl = document.getElementById('ndl-value');

const nitroxValueEl = document.getElementById('nitrox-value');
const altitudeValueEl = document.getElementById('altitude-value');
const altitudeIconEl = document.getElementById('altitude-icon');
const gfValueEl = document.getElementById('gf-value');
const gfIconEl = document.getElementById('gf-icon');

const startBtn = document.getElementById('start-btn');
const speedSlider = document.getElementById('speed-slider');
const speedValueEl = document.getElementById('speed-value');
const warningBannerEl = document.getElementById('warning-banner');

const barsCanvas = document.getElementById('bars-canvas');
const barsCtx = barsCanvas.getContext('2d');
const barsLabelsEl = document.getElementById('bars-labels');

// ---------------------------------------------------------------------------
// Profile graph
// ---------------------------------------------------------------------------

function resizeProfileCanvas() {
  const rect = profileCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  profileCanvas.width = rect.width * dpr;
  profileCanvas.height = rect.height * dpr;
  profileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawProfile();
}

function sortWaypoints() {
  state.waypoints.sort((a, b) => a.t - b.t);
}

function updateGraphScale() {
  const maxT = Math.max(...state.waypoints.map((w) => w.t));
  const maxD = Math.max(...state.waypoints.map((w) => w.d));
  state.maxTime = Math.max(60, maxT + 10);
  state.maxDepth = Math.max(40, maxD + 8);
}

function graphSize() {
  const rect = profileCanvas.getBoundingClientRect();
  const pad = 24;
  return { w: rect.width - pad * 2, h: rect.height - pad * 2, pad };
}

function timeToX(t) {
  const { w, pad } = graphSize();
  return pad + (t / state.maxTime) * w;
}
function xToTime(x) {
  const { w, pad } = graphSize();
  return ((x - pad) / w) * state.maxTime;
}
function depthToY(d) {
  const { h, pad } = graphSize();
  return pad + (d / state.maxDepth) * h;
}
function yToDepth(y) {
  const { h, pad } = graphSize();
  return ((y - pad) / h) * state.maxDepth;
}

function depthAtTime(t) {
  const wp = state.waypoints;
  if (t <= wp[0].t) return wp[0].d;
  for (let i = 0; i < wp.length - 1; i++) {
    if (t >= wp[i].t && t <= wp[i + 1].t) {
      const span = wp[i + 1].t - wp[i].t;
      if (span <= 0) return wp[i + 1].d;
      const frac = (t - wp[i].t) / span;
      return wp[i].d + frac * (wp[i + 1].d - wp[i].d);
    }
  }
  return wp[wp.length - 1].d;
}

// A waypoint at or before the current simulated time represents dive history
// and can't be edited — only the remaining, not-yet-lived portion of the
// profile is editable, whether the sim is running or paused.
function isWaypointLocked(wp) {
  return state.simElapsedMinutes > 0 && wp.t <= state.simElapsedMinutes + LOCK_EPSILON;
}

function drawProfile() {
  const rect = profileCanvas.getBoundingClientRect();
  const { w, h, pad } = graphSize();
  profileCtx.clearRect(0, 0, rect.width, rect.height);

  // axes
  profileCtx.strokeStyle = '#1c2833';
  profileCtx.lineWidth = 1;
  profileCtx.strokeRect(pad, pad, w, h);

  // depth gridlines every 10m
  profileCtx.fillStyle = '#5f7d8f';
  profileCtx.font = '10px monospace';
  for (let d = 0; d <= state.maxDepth; d += 10) {
    const y = depthToY(d);
    profileCtx.strokeStyle = '#131b23';
    profileCtx.beginPath();
    profileCtx.moveTo(pad, y);
    profileCtx.lineTo(pad + w, y);
    profileCtx.stroke();
    profileCtx.fillText(String(d), 2, y + 3);
  }

  // time gridlines every 10min
  for (let t = 0; t <= state.maxTime; t += 10) {
    const x = timeToX(t);
    profileCtx.strokeStyle = '#131b23';
    profileCtx.beginPath();
    profileCtx.moveTo(x, pad);
    profileCtx.lineTo(x, pad + h);
    profileCtx.stroke();
    profileCtx.fillText(String(t), x - 6, pad + h + 14);
  }

  // current-time cursor
  if (state.simRunning || state.simElapsedMinutes > 0) {
    const lastT = state.waypoints[state.waypoints.length - 1].t;
    const cursorT = Math.min(state.simElapsedMinutes, lastT);
    const x = timeToX(cursorT);
    profileCtx.setLineDash([4, 4]);
    profileCtx.strokeStyle = '#ffffff';
    profileCtx.lineWidth = 1;
    profileCtx.beginPath();
    profileCtx.moveTo(x, pad);
    profileCtx.lineTo(x, pad + h);
    profileCtx.stroke();
    profileCtx.setLineDash([]);
  }

  // profile line
  profileCtx.strokeStyle = '#37e6c4';
  profileCtx.lineWidth = 2;
  profileCtx.beginPath();
  state.waypoints.forEach((wp, i) => {
    const x = timeToX(wp.t);
    const y = depthToY(wp.d);
    if (i === 0) profileCtx.moveTo(x, y);
    else profileCtx.lineTo(x, y);
  });
  profileCtx.stroke();

  // waypoint handles — dimmed where locked (already-lived history)
  state.waypoints.forEach((wp) => {
    const x = timeToX(wp.t);
    const y = depthToY(wp.d);
    profileCtx.fillStyle = isWaypointLocked(wp) ? '#5f7d8f' : '#37e6c4';
    profileCtx.beginPath();
    profileCtx.arc(x, y, 5, 0, Math.PI * 2);
    profileCtx.fill();
  });

  // moving marker
  if (state.simRunning || state.simElapsedMinutes > 0) {
    const t = Math.min(state.simElapsedMinutes, state.waypoints[state.waypoints.length - 1].t);
    const x = timeToX(t);
    const y = depthToY(depthAtTime(t));
    profileCtx.fillStyle = '#e8b93a';
    profileCtx.beginPath();
    profileCtx.arc(x, y, 6, 0, Math.PI * 2);
    profileCtx.fill();
    profileCtx.strokeStyle = '#05080c';
    profileCtx.lineWidth = 1.5;
    profileCtx.stroke();
  }

  // replay/preview cursor — grey, shown only while scrubbing; the white
  // "actual dive time" cursor above stays in place so both are visible.
  if (state.previewTimeMinutes !== null) {
    const previewX = timeToX(state.previewTimeMinutes);
    profileCtx.setLineDash([4, 4]);
    profileCtx.strokeStyle = '#5f7d8f';
    profileCtx.lineWidth = 1;
    profileCtx.beginPath();
    profileCtx.moveTo(previewX, pad);
    profileCtx.lineTo(previewX, pad + h);
    profileCtx.stroke();
    profileCtx.setLineDash([]);

    const previewY = depthToY(depthAtTime(state.previewTimeMinutes));
    profileCtx.fillStyle = '#5f7d8f';
    profileCtx.beginPath();
    profileCtx.arc(previewX, previewY, 5, 0, Math.PI * 2);
    profileCtx.fill();
  }
}

function findWaypointNear(x, y) {
  const threshold = 10;
  for (let i = 0; i < state.waypoints.length; i++) {
    if (isWaypointLocked(state.waypoints[i])) continue;
    const wx = timeToX(state.waypoints[i].t);
    const wy = depthToY(state.waypoints[i].d);
    if (Math.hypot(wx - x, wy - y) <= threshold) return i;
  }
  return null;
}

function canvasPoint(evt) {
  const rect = profileCanvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

// Dragging within the already-lived (locked) portion of the timeline while
// paused scrubs a non-destructive preview instead of grabbing a waypoint —
// that zone is otherwise dead space for mousedown (locked waypoints are
// already unclickable), so there's no collision with waypoint editing.
function inScrubbableZone(x) {
  return !state.simRunning && state.simElapsedMinutes > 0 && xToTime(x) <= state.simElapsedMinutes;
}

// Hover feedback: the scrubbable timeline gets a horizontal resize cursor,
// otherwise the default crosshair. Doesn't run while actively dragging or
// scrubbing so it doesn't fight the cursor set for that interaction.
profileCanvas.addEventListener('mousemove', (evt) => {
  if (state.dragIndex !== null || state.previewTimeMinutes !== null) return;
  const { x } = canvasPoint(evt);
  profileCanvas.style.cursor = inScrubbableZone(x) ? 'ew-resize' : 'crosshair';
});

profileCanvas.addEventListener('mousedown', (evt) => {
  const { x, y } = canvasPoint(evt);
  if (inScrubbableZone(x)) {
    profileCanvas.style.cursor = 'ew-resize';
    state.previewTimeMinutes = Math.max(0, Math.min(state.simElapsedMinutes, xToTime(x)));
    renderPreview();
    return;
  }
  state.dragIndex = findWaypointNear(x, y);
  state.dragMoved = false;
});

window.addEventListener('mousemove', (evt) => {
  if (state.previewTimeMinutes !== null) {
    const { x } = canvasPoint(evt);
    state.previewTimeMinutes = Math.max(0, Math.min(state.simElapsedMinutes, xToTime(x)));
    renderPreview();
    return;
  }
  if (state.dragIndex === null) return;
  const { x, y } = canvasPoint(evt);
  state.dragMoved = true;
  const minT = state.simElapsedMinutes > 0 ? state.simElapsedMinutes + LOCK_EPSILON : 0;
  // Snap to a 1 minute / 1 meter grid.
  const t = Math.max(minT, Math.round(xToTime(x)));
  const d = Math.max(0, Math.round(yToDepth(y)));
  state.waypoints[state.dragIndex] = { t, d };
  updateGraphScale();
  drawProfile();
});

window.addEventListener('mouseup', (evt) => {
  if (state.previewTimeMinutes !== null) {
    state.previewTimeMinutes = null;
    updateDisplay(liveSnapshot());
    drawBars();
    drawProfile();
    return;
  }
  const { x, y } = canvasPoint(evt);
  const inCanvas =
    x >= 0 && y >= 0 && x <= profileCanvas.getBoundingClientRect().width &&
    y <= profileCanvas.getBoundingClientRect().height;

  if (state.dragIndex !== null) {
    if (!state.dragMoved && inCanvas) {
      // plain click on an existing waypoint: delete it (keep at least one)
      if (state.waypoints.length > 1) {
        state.waypoints.splice(state.dragIndex, 1);
      }
    } else {
      sortWaypoints();
    }
  } else if (inCanvas) {
    // click on empty space: add a new waypoint (only in the editable future),
    // snapped to a 1 minute / 1 meter grid
    const t = Math.max(0, Math.round(xToTime(x)));
    const d = Math.max(0, Math.round(yToDepth(y)));
    if (state.simElapsedMinutes === 0 || t > state.simElapsedMinutes + LOCK_EPSILON) {
      state.waypoints.push({ t, d });
      sortWaypoints();
    }
  }

  state.dragIndex = null;
  state.dragMoved = false;
  updateGraphScale();
  drawProfile();
});

window.addEventListener('resize', resizeProfileCanvas);
window.addEventListener('resize', resizeBarsCanvas);

// ---------------------------------------------------------------------------
// Computer display: selectors
// ---------------------------------------------------------------------------

function drawAltitudeIcon() {
  const level = state.altitudeIndex;
  let svg = '<line x1="0" y1="18" x2="34" y2="18" stroke="#cdeeff" stroke-width="2"/>';
  if (level >= 1) {
    svg += '<polygon points="10,18 17,8 24,18" fill="none" stroke="#cdeeff" stroke-width="1.5"/>';
  }
  if (level >= 2) {
    svg += '<polygon points="4,18 17,2 30,18" fill="none" stroke="#37e6c4" stroke-width="1.5"/>';
  }
  altitudeIconEl.innerHTML = svg;
}

function drawGfIcon() {
  const lit = GF_PRESETS[state.gfIndex].bars;
  let svg = '';
  // i=0 is the top bar, i=2 is the bottom bar — light from the bottom up
  // so the least-conservative preset (1 bar) highlights the lowest bar.
  for (let i = 0; i < 3; i++) {
    const y = 2 + i * 6;
    const color = i >= 3 - lit ? '#37e6c4' : '#1c2833';
    svg += `<rect x="0" y="${y}" width="34" height="4" fill="${color}" />`;
  }
  gfIconEl.innerHTML = svg;
}

function refreshSelectorLabels() {
  nitroxValueEl.textContent = String(state.nitroxPercent);
  altitudeValueEl.textContent = `${ALTITUDE_PRESETS[state.altitudeIndex]} m`;
  const gfPreset = GF_PRESETS[state.gfIndex];
  gfValueEl.textContent = `${gfPreset.low}/${gfPreset.high}`;
  drawAltitudeIcon();
  drawGfIcon();
}

// Nitrox and altitude are locked once a dive starts — you can't change your
// gas or teleport to a different altitude mid-dive. Selectable again only
// after a full reset, same as before the dive started.
document.getElementById('nitrox-up').addEventListener('click', () => {
  if (state.simElapsedMinutes > 0) return;
  state.nitroxPercent = Math.min(50, state.nitroxPercent + 1);
  refreshSelectorLabels();
  drawBars();
});
document.getElementById('nitrox-down').addEventListener('click', () => {
  if (state.simElapsedMinutes > 0) return;
  state.nitroxPercent = Math.max(21, state.nitroxPercent - 1);
  refreshSelectorLabels();
  drawBars();
});

document.getElementById('altitude-up').addEventListener('click', () => {
  if (state.simElapsedMinutes > 0) return;
  state.altitudeIndex = Math.min(2, state.altitudeIndex + 1);
  refreshSelectorLabels();
  drawBars();
});
document.getElementById('altitude-down').addEventListener('click', () => {
  if (state.simElapsedMinutes > 0) return;
  state.altitudeIndex = Math.max(0, state.altitudeIndex - 1);
  refreshSelectorLabels();
  drawBars();
});

document.getElementById('gf-up').addEventListener('click', () => {
  state.gfIndex = (state.gfIndex + 1) % GF_PRESETS.length;
  refreshSelectorLabels();
});
document.getElementById('gf-down').addEventListener('click', () => {
  state.gfIndex = (state.gfIndex - 1 + GF_PRESETS.length) % GF_PRESETS.length;
  refreshSelectorLabels();
});

speedSlider.addEventListener('input', () => {
  state.simSpeed = Number(speedSlider.value);
  speedValueEl.textContent = `${state.simSpeed}x`;
  // Re-anchor timing so the speed change takes effect immediately.
  if (state.simRunning) {
    state.simElapsedAtStart = state.simElapsedMinutes;
    state.simStartReal = performance.now();
  }
});

// ---------------------------------------------------------------------------
// Compartment bars
// ---------------------------------------------------------------------------

function buildBarLabels() {
  barsLabelsEl.innerHTML = '';
  COMPARTMENTS.forEach((_, i) => {
    const span = document.createElement('span');
    span.textContent = String(i + 1);
    barsLabelsEl.appendChild(span);
  });
}

function resizeBarsCanvas() {
  const rect = barsCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  barsCanvas.width = rect.width * dpr;
  barsCanvas.height = rect.height * dpr;
  barsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBars();
}

const BAR_SCALE_MAX = 6; // bar of pressure represented by full bar height
const BARS_LEFT_PAD = 56; // reserves room for the 'M-Value' / 'PN2 0.79' labels; keep in sync with #bars-labels padding-left in styles.css

function drawBars(tissues = state.tissues) {
  const rect = barsCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const plotW = w - BARS_LEFT_PAD;
  const colWidth = plotW / COMPARTMENTS.length;
  barsCtx.clearRect(0, 0, w, h);

  const env = currentEnvironment();
  // The M-value threshold tracks total ambient pressure at the surface, not
  // the breathing gas's inert-gas fraction (nitrox changes loading, not the
  // threshold) — matches computeNDL's corrected surfaceReference.
  const surfaceAmbient = surfacePressureAtAltitude(env.altitudeMeters);
  const surfaceMValues = COMPARTMENTS.map(({ a, b }) => mValue(surfaceAmbient, a, b));
  // Real atmospheric PPN2 at the surface — always air's fraction, since you
  // return to breathing atmosphere regardless of what gas you dove on.
  const surfacePN2 = inspiredInertGasPressure(surfaceAmbient, 21);

  // tissue loading bars, color-coded by % of surface M-value
  for (let i = 0; i < COMPARTMENTS.length; i++) {
    const colX = BARS_LEFT_PAD + i * colWidth;
    const pTissue = tissues[i];
    const loadPercent = (pTissue / surfaceMValues[i]) * 100;
    const barY = h - (pTissue / BAR_SCALE_MAX) * h;

    let color = '#2fd06a';
    if (loadPercent > 85) color = '#e5484d';
    else if (loadPercent > 65) color = '#e8b93a';

    barsCtx.fillStyle = color;
    barsCtx.fillRect(colX + 4, Math.max(0, barY), colWidth - 8, h - Math.max(0, barY));
  }

  // M-value curve: one polyline connecting each compartment's fixed surface M-value
  barsCtx.strokeStyle = '#bcdfff';
  barsCtx.lineWidth = 2;
  barsCtx.beginPath();
  surfaceMValues.forEach((m, i) => {
    const x = compartmentCenterX(i, colWidth);
    const y = h - (m / BAR_SCALE_MAX) * h;
    if (i === 0) barsCtx.moveTo(x, y);
    else barsCtx.lineTo(x, y);
  });
  barsCtx.stroke();
  surfaceMValues.forEach((m, i) => {
    const x = compartmentCenterX(i, colWidth);
    const y = h - (m / BAR_SCALE_MAX) * h;
    barsCtx.fillStyle = '#bcdfff';
    barsCtx.beginPath();
    barsCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    barsCtx.fill();
  });

  // atmospheric surface PN2 reference line — informational only, distinct
  // from the M-value threshold above
  const pAmbY = h - (surfacePN2 / BAR_SCALE_MAX) * h;
  barsCtx.setLineDash([4, 4]);
  barsCtx.strokeStyle = '#ffffff';
  barsCtx.lineWidth = 1;
  barsCtx.beginPath();
  barsCtx.moveTo(BARS_LEFT_PAD, pAmbY);
  barsCtx.lineTo(w, pAmbY);
  barsCtx.stroke();
  barsCtx.setLineDash([]);

  // labels in the reserved left margin, horizontal, at each line's level
  barsCtx.font = '10px monospace';
  barsCtx.textBaseline = 'middle';
  const mValueLabelY = h - (surfaceMValues[0] / BAR_SCALE_MAX) * h;
  barsCtx.fillStyle = '#bcdfff';
  barsCtx.fillText('M-Value', 2, mValueLabelY);
  barsCtx.fillStyle = '#ffffff';
  barsCtx.fillText(`PN2 ${surfacePN2.toFixed(2)}`, 2, pAmbY);
}

function compartmentCenterX(i, colWidth) {
  return BARS_LEFT_PAD + i * colWidth + colWidth / 2;
}

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------

function formatTime(minutes) {
  const totalSeconds = Math.floor(minutes * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// snapshot: { depth, minutes, ndl, ceilingDepthRounded, decoStopSecondsRemaining, errorTriggered }
function updateDisplay(snapshot) {
  depthValueEl.textContent = snapshot.depth.toFixed(1);
  timeValueEl.textContent = formatTime(snapshot.minutes);

  if (snapshot.errorTriggered) {
    ndlLabelEl.textContent = '';
    ndlValueEl.textContent = 'ERROR';
    ndlValueEl.classList.add('blink-error');
    ndlValueEl.classList.remove('compact-value');
  } else if (snapshot.ceilingDepthRounded > 0) {
    const stopMinutes = Math.ceil(snapshot.decoStopSecondsRemaining / 60);
    ndlLabelEl.textContent = 'Ceiling / Stop';
    ndlValueEl.textContent = `${snapshot.ceilingDepthRounded}m / ${stopMinutes}min`;
    ndlValueEl.classList.remove('blink-error');
    ndlValueEl.classList.add('compact-value');
  } else if (snapshot.safetyStopSecondsRemaining !== null) {
    ndlLabelEl.textContent = 'Safety Stop';
    ndlValueEl.textContent = snapshot.safetyStopSecondsRemaining > 0
      ? String(Math.ceil(snapshot.safetyStopSecondsRemaining / 60))
      : '--';
    ndlValueEl.classList.remove('blink-error');
    ndlValueEl.classList.add('compact-value');
  } else {
    ndlLabelEl.textContent = 'NDL (min)';
    ndlValueEl.textContent = snapshot.ndl > 99 ? '--' : String(snapshot.ndl);
    ndlValueEl.classList.remove('blink-error', 'compact-value');
  }
}

// The live values, exactly as currently simulated — reads existing state
// fields directly, no recomputation.
function liveSnapshot() {
  return {
    depth: depthAtTime(state.simElapsedMinutes),
    minutes: state.simElapsedMinutes,
    tissues: state.tissues,
    ndl: state.ndl,
    ceilingDepthRounded: state.ceilingDepthRounded,
    decoStopSecondsRemaining: state.decoStopSecondsRemaining,
    errorTriggered: state.errorTriggered,
    safetyStopSecondsRemaining: state.safetyStopSecondsRemaining,
  };
}

// Replays tissue state from t=0 up to targetMinutes using the current
// waypoints — pure/derived, never touches state.tissues. Used for
// non-destructive timeline scrubbing. Also tracks the same rolling ceiling
// anchor the live simulation would have accumulated by that point (see
// gfAnchorDepth), so a replayed instant reports the same ceiling the live
// sim did/would, rather than recomputing GF_now from a bare replayed depth.
function replayTissuesTo(targetMinutes) {
  const env = currentEnvironment();
  let tissues = createCompartments(env.nitroxPercent, env.altitudeMeters);
  let previousCeiling = 0;
  let hasDescendedPastSafetyZone = false;
  let safetyStopEnteredAtMinute = null;
  const gf = currentGF();
  const wholeMinutes = Math.floor(targetMinutes);
  for (let m = 1; m <= wholeMinutes; m++) {
    const d = depthAtTime(m);
    const pAmb = ambientPressureAtDepth(d, env.altitudeMeters);
    tissues = stepCompartments(tissues, inspiredInertGasPressure(pAmb, env.nitroxPercent), 1);
    previousCeiling = ceilingDepth(tissues, gfAnchorDepth(d, previousCeiling), gf.low, gf.high, env.altitudeMeters);

    if (d > SAFETY_STOP_ZONE_DEPTH) {
      hasDescendedPastSafetyZone = true;
      safetyStopEnteredAtMinute = null;
    } else if (hasDescendedPastSafetyZone && safetyStopEnteredAtMinute === null) {
      safetyStopEnteredAtMinute = m;
    }
  }
  return { tissues, previousCeiling, safetyStopEnteredAtMinute };
}

// Same shape as liveSnapshot(), but recomputed for an arbitrary past instant.
function previewSnapshot(targetMinutes) {
  const { tissues, previousCeiling, safetyStopEnteredAtMinute } = replayTissuesTo(targetMinutes);
  const depth = depthAtTime(targetMinutes);
  const gf = currentGF();
  const env = currentEnvironment();
  const ndl = computeNDL(tissues, depth, gf.low, env.nitroxPercent, env.altitudeMeters);
  const gfDepth = gfAnchorDepth(depth, previousCeiling);
  const { ceilingDepth: ceiling } = computeCeiling(tissues, gfDepth, gf.low, gf.high, env.altitudeMeters);
  const decoStopSecondsRemaining = ceiling > 0
    ? computeDecoStopSeconds(tissues, ceiling, gf.low, gf.high, env.nitroxPercent, env.altitudeMeters)
    : 0;
  const errorTriggered = state.errorTriggeredAtMinute !== null &&
    targetMinutes >= state.errorTriggeredAtMinute;
  const safetyStopSecondsRemaining = safetyStopEnteredAtMinute === null
    ? null
    : Math.max(0, SAFETY_STOP_SECONDS - (targetMinutes - safetyStopEnteredAtMinute) * 60);

  return {
    depth,
    minutes: targetMinutes,
    tissues,
    ndl,
    ceilingDepthRounded: ceiling,
    decoStopSecondsRemaining,
    errorTriggered,
    safetyStopSecondsRemaining,
  };
}

function renderPreview() {
  const snapshot = previewSnapshot(state.previewTimeMinutes);
  updateDisplay(snapshot);
  drawBars(snapshot.tissues);
  drawProfile();
}

function stepEngineToMinute(minute) {
  const depth = depthAtTime(minute);
  const env = currentEnvironment();
  const pAmb = ambientPressureAtDepth(depth, env.altitudeMeters);
  state.tissues = stepCompartments(state.tissues, inspiredInertGasPressure(pAmb, env.nitroxPercent), 1);

  const gf = currentGF();
  state.ndl = computeNDL(state.tissues, depth, gf.low, env.nitroxPercent, env.altitudeMeters);

  // TEMPORARY DIAGNOSTIC: DEBUG_DECO gates the verbose per-compartment log
  // in engine.js. Only set true for the ad-hoc diagnostic test run.
  const debugLabel = DEBUG_DECO ? `t=${minute}min depth=${depth.toFixed(2)}m` : null;
  const gfDepth = gfAnchorDepth(depth, state.previousCeiling);
  const { ceilingDepth: roundedCeiling } = computeCeiling(state.tissues, gfDepth, gf.low, gf.high, env.altitudeMeters, debugLabel);
  state.ceilingDepthRounded = roundedCeiling;
  // Deco stop time is "how long once I hold at my required stop," not "how
  // long from wherever I am right now" — evaluate at roundedCeiling, not at
  // the diver's actual (possibly still-deeper) current depth. Otherwise
  // this is always 0 until the diver has physically ascended to the stop.
  state.decoStopSecondsRemaining = roundedCeiling > 0
    ? computeDecoStopSeconds(state.tissues, roundedCeiling, gf.low, gf.high, env.nitroxPercent, env.altitudeMeters)
    : 0;

  // Advisory safety stop (3 min at ~5m) — unlike the ceiling above, this is
  // never enforced, just tracked for display. Re-entering the zone after
  // descending back out restarts the countdown from scratch.
  if (depth > SAFETY_STOP_ZONE_DEPTH) {
    state.hasDescendedPastSafetyZone = true;
    state.safetyStopEnteredAtMinute = null;
  } else if (state.hasDescendedPastSafetyZone && state.safetyStopEnteredAtMinute === null) {
    state.safetyStopEnteredAtMinute = minute;
  }
  state.safetyStopSecondsRemaining = state.safetyStopEnteredAtMinute === null
    ? null
    : Math.max(0, SAFETY_STOP_SECONDS - (minute - state.safetyStopEnteredAtMinute) * 60);
}

function showWarning(message) {
  warningBannerEl.textContent = message;
  warningBannerEl.hidden = false;
}

function clearWarning() {
  warningBannerEl.textContent = '';
  warningBannerEl.hidden = true;
}

// Fixes the already-lived portion of the profile in place: inserts a
// waypoint at the exact pause position (if one isn't already there) so a
// later edit to a future waypoint can't reshape history.
function pinCurrentWaypoint() {
  const t = state.simElapsedMinutes;
  const d = depthAtTime(t);
  const alreadyPinned = state.waypoints.some((wp) => Math.abs(wp.t - t) < LOCK_EPSILON);
  if (!alreadyPinned) {
    state.waypoints.push({ t, d });
    sortWaypoints();
    updateGraphScale();
  }
}

function updateStartButton() {
  if (state.simRunning) {
    startBtn.textContent = 'Pause';
    startBtn.classList.remove('btn-warning');
  } else if (state.pauseReason) {
    // paused mid-dive — manually, or by an automatic safety pause —
    // regardless of how close simElapsedMinutes happens to sit to the last
    // waypoint's time (a pause can land exactly on the final minute).
    startBtn.textContent = 'Continue Dive';
    startBtn.classList.add('btn-warning');
  } else {
    startBtn.textContent = 'Start Simulation';
    startBtn.classList.remove('btn-warning');
  }
}

// Stops the sim loop for any reason (manual pause or an automatic safety
// pause), fixes history in place, and surfaces the relevant warning.
function pauseSimulation(reason) {
  state.simRunning = false;
  state.pauseReason = reason;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  pinCurrentWaypoint();

  if (reason === 'ndl-warning') showWarning(MSG_NDL_WARNING);
  else if (reason === 'ceiling-breach') showWarning(MSG_CEILING_BREACH);
  else clearWarning();

  updateStartButton();
  drawProfile();
}

function finishDive() {
  state.simRunning = false;
  state.pauseReason = null;
  state.diveFinished = true;
  updateStartButton();

  const env = currentEnvironment();
  const exceededLimits = hasSurfacingViolation(state.tissues, env.altitudeMeters);
  if (exceededLimits) {
    showWarning(MSG_DCS_RISK);
    if (!state.errorTriggered) {
      state.errorTriggered = true;
      state.errorTriggeredAtMinute = state.simElapsedMinutes;
    }
  } else if (state.safetyStopEnteredAtMinute !== null && state.safetyStopSecondsRemaining > 0) {
    // Advisory only — surfacing before the countdown completes doesn't
    // trigger ERROR or count as a DCS risk, just a habit reminder.
    showWarning(MSG_SAFETY_STOP_SKIPPED);
  } else {
    clearWarning();
  }
  updateDisplay(liveSnapshot());
}

function simulationFrame() {
  const msPerMinute = 60000 / state.simSpeed;
  const elapsedRealMs = performance.now() - state.simStartReal;
  const lastWaypointTime = state.waypoints[state.waypoints.length - 1].t;

  state.simElapsedMinutes = Math.min(
    state.simElapsedAtStart + elapsedRealMs / msPerMinute,
    lastWaypointTime
  );

  const wholeMinute = Math.floor(state.simElapsedMinutes);
  while (state.lastWholeMinute < wholeMinute) {
    state.lastWholeMinute++;
    stepEngineToMinute(state.lastWholeMinute);

    const depthAtStep = depthAtTime(state.lastWholeMinute);
    const gf = currentGF();
    const env = currentEnvironment();
    // previousCeiling is read as the anchor BEFORE being overwritten below —
    // see gfAnchorDepth's doc comment for why the anchor is needed here.
    const ceiling = ceilingDepth(state.tissues, gfAnchorDepth(depthAtStep, state.previousCeiling), gf.low, gf.high, env.altitudeMeters);

    // A stop was already required last minute and the diver is now
    // shallower than that — a required stop was left early. The first
    // ceiling-breach of a dive (previousCeiling was still 0) just means "a
    // stop is now required," not a violation.
    if (state.previousCeiling > 0 && depthAtStep < state.previousCeiling) {
      if (!state.errorTriggered) {
        state.errorTriggered = true;
        state.errorTriggeredAtMinute = state.lastWholeMinute;
      }
    }
    state.previousCeiling = ceiling;

    if (ceiling > 0 && depthAtStep < ceiling) {
      state.simElapsedMinutes = state.lastWholeMinute;
      updateDisplay(liveSnapshot());
      drawBars();
      pauseSimulation('ceiling-breach');
      return;
    }

    if (!state.ndlWarningShown && Number.isFinite(state.ndl) && state.ndl < 3) {
      state.ndlWarningShown = true;
      state.simElapsedMinutes = state.lastWholeMinute;
      updateDisplay(liveSnapshot());
      drawBars();
      pauseSimulation('ndl-warning');
      return;
    }
  }

  updateDisplay(liveSnapshot());
  drawBars();
  drawProfile();

  if (state.simElapsedMinutes >= lastWaypointTime) {
    finishDive();
    return;
  }

  state.rafId = requestAnimationFrame(simulationFrame);
}

startBtn.addEventListener('click', () => {
  if (state.waypoints.length < 2) {
    alert('Add at least two waypoints to the dive profile before starting.');
    return;
  }

  if (state.simRunning) {
    pauseSimulation('manual');
    return;
  }

  // (Re)start / resume
  if (state.diveFinished) {
    // previous run finished — reset
    state.simElapsedMinutes = 0;
    state.lastWholeMinute = -1;
    const env = currentEnvironment();
    state.tissues = createCompartments(env.nitroxPercent, env.altitudeMeters);
    state.ndl = Infinity;
    state.ndlWarningShown = false;
    state.pauseReason = null;
    state.diveFinished = false;
    state.ceilingDepthRounded = 0;
    state.decoStopSecondsRemaining = 0;
    state.previousCeiling = 0;
    state.errorTriggered = false;
    state.errorTriggeredAtMinute = null;
    state.hasDescendedPastSafetyZone = false;
    state.safetyStopEnteredAtMinute = null;
    state.safetyStopSecondsRemaining = null;
    clearWarning();
  } else if (state.pauseReason) {
    // resuming from a pause (manual, ndl-warning, or ceiling-breach)
    state.pauseReason = null;
    clearWarning();
  }

  state.simRunning = true;
  updateStartButton();
  state.simElapsedAtStart = state.simElapsedMinutes;
  state.simStartReal = performance.now();
  state.rafId = requestAnimationFrame(simulationFrame);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

sortWaypoints();
updateGraphScale();
buildBarLabels();
refreshSelectorLabels();
resizeProfileCanvas();
resizeBarsCanvas();
updateDisplay(liveSnapshot());
updateStartButton();
clearWarning();
