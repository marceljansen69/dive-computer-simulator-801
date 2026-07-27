// UI layer: rendering, DOM events, animation loop.
// All decompression math is delegated to engine.js — this file never
// computes tissue pressures itself.

import {
  COMPARTMENTS,
  createCompartments,
  stepCompartments,
  ambientPressureAtDepth,
  mValue,
  computeNDL,
  PAMB_0,
} from './engine.js';

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
  gfIndex: 0,                  // 0 / 1 / 2 -> 30/70, 40/85, 50/90, placeholder only

  simRunning: false,
  simSpeed: 1,
  simStartReal: 0,       // performance.now() at (re)start
  simElapsedAtStart: 0,  // simulated minutes already elapsed when (re)started
  lastWholeMinute: -1,   // last integer minute the engine has processed
  simElapsedMinutes: 0,

  tissues: createCompartments(21),
  ndl: Infinity,
  rafId: null,

  dragIndex: null,
  dragMoved: false,
};

const ALTITUDE_PRESETS = [0, 1500, 3000];
const GF_PRESETS = [
  { label: '30/70', bars: 1 },
  { label: '40/85', bars: 2 },
  { label: '50/90', bars: 3 },
];

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const profileCanvas = document.getElementById('profile-canvas');
const profileCtx = profileCanvas.getContext('2d');

const depthValueEl = document.getElementById('depth-value');
const timeValueEl = document.getElementById('time-value');
const ndlValueEl = document.getElementById('ndl-value');

const nitroxValueEl = document.getElementById('nitrox-value');
const altitudeValueEl = document.getElementById('altitude-value');
const altitudeIconEl = document.getElementById('altitude-icon');
const gfValueEl = document.getElementById('gf-value');
const gfIconEl = document.getElementById('gf-icon');

const startBtn = document.getElementById('start-btn');
const speedSlider = document.getElementById('speed-slider');
const speedValueEl = document.getElementById('speed-value');

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

  // waypoint handles
  state.waypoints.forEach((wp) => {
    const x = timeToX(wp.t);
    const y = depthToY(wp.d);
    profileCtx.fillStyle = '#37e6c4';
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
}

function findWaypointNear(x, y) {
  const threshold = 10;
  for (let i = 0; i < state.waypoints.length; i++) {
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

profileCanvas.addEventListener('mousedown', (evt) => {
  const { x, y } = canvasPoint(evt);
  state.dragIndex = findWaypointNear(x, y);
  state.dragMoved = false;
});

window.addEventListener('mousemove', (evt) => {
  if (state.dragIndex === null) return;
  const { x, y } = canvasPoint(evt);
  state.dragMoved = true;
  const t = Math.max(0, xToTime(x));
  const d = Math.max(0, yToDepth(y));
  state.waypoints[state.dragIndex] = { t, d };
  updateGraphScale();
  drawProfile();
});

window.addEventListener('mouseup', (evt) => {
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
    // click on empty space: add a new waypoint
    const t = Math.max(0, xToTime(x));
    const d = Math.max(0, yToDepth(y));
    state.waypoints.push({ t, d });
    sortWaypoints();
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
  for (let i = 0; i < 3; i++) {
    const y = 2 + i * 6;
    const color = i < lit ? '#37e6c4' : '#1c2833';
    svg += `<rect x="0" y="${y}" width="34" height="4" fill="${color}" />`;
  }
  gfIconEl.innerHTML = svg;
}

function refreshSelectorLabels() {
  nitroxValueEl.textContent = String(state.nitroxPercent);
  altitudeValueEl.textContent = `${ALTITUDE_PRESETS[state.altitudeIndex]} m`;
  gfValueEl.textContent = GF_PRESETS[state.gfIndex].label;
  drawAltitudeIcon();
  drawGfIcon();
}

document.getElementById('nitrox-up').addEventListener('click', () => {
  state.nitroxPercent = Math.min(50, state.nitroxPercent + 1);
  refreshSelectorLabels();
});
document.getElementById('nitrox-down').addEventListener('click', () => {
  state.nitroxPercent = Math.max(21, state.nitroxPercent - 1);
  refreshSelectorLabels();
});

document.getElementById('altitude-up').addEventListener('click', () => {
  state.altitudeIndex = Math.min(2, state.altitudeIndex + 1);
  refreshSelectorLabels();
});
document.getElementById('altitude-down').addEventListener('click', () => {
  state.altitudeIndex = Math.max(0, state.altitudeIndex - 1);
  refreshSelectorLabels();
});

document.getElementById('gf-up').addEventListener('click', () => {
  state.gfIndex = Math.min(2, state.gfIndex + 1);
  refreshSelectorLabels();
});
document.getElementById('gf-down').addEventListener('click', () => {
  state.gfIndex = Math.max(0, state.gfIndex - 1);
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

function drawBars() {
  const rect = barsCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const plotW = w - BARS_LEFT_PAD;
  const colWidth = plotW / COMPARTMENTS.length;
  barsCtx.clearRect(0, 0, w, h);

  const surfaceMValues = COMPARTMENTS.map(({ a, b }) => mValue(PAMB_0, a, b));

  // tissue loading bars, color-coded by % of surface M-value
  for (let i = 0; i < COMPARTMENTS.length; i++) {
    const colX = BARS_LEFT_PAD + i * colWidth;
    const pTissue = state.tissues[i];
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

  // fixed surface ambient pressure line (PN2 0.79)
  const pAmbY = h - (PAMB_0 / BAR_SCALE_MAX) * h;
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
  barsCtx.fillText('PN2 0.79', 2, pAmbY);
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

function updateDisplay(depth) {
  depthValueEl.textContent = depth.toFixed(1);
  timeValueEl.textContent = formatTime(state.simElapsedMinutes);
  ndlValueEl.textContent = state.ndl === Infinity ? '--' : String(state.ndl);
}

function stepEngineToMinute(minute) {
  const depth = depthAtTime(minute);
  const pAmb = ambientPressureAtDepth(depth);
  state.tissues = stepCompartments(state.tissues, pAmb, 1);
  state.ndl = computeNDL(state.tissues, depth);
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
  }

  const depth = depthAtTime(state.simElapsedMinutes);
  updateDisplay(depth);
  drawBars();
  drawProfile();

  if (state.simElapsedMinutes >= lastWaypointTime) {
    state.simRunning = false;
    startBtn.textContent = 'Start Simulation';
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
    state.simRunning = false;
    startBtn.textContent = 'Start Simulation';
    if (state.rafId) cancelAnimationFrame(state.rafId);
    return;
  }

  // (Re)start / resume
  if (state.simElapsedMinutes >= state.waypoints[state.waypoints.length - 1].t) {
    // previous run finished — reset
    state.simElapsedMinutes = 0;
    state.lastWholeMinute = -1;
    state.tissues = createCompartments(21);
    state.ndl = Infinity;
  }

  state.simRunning = true;
  startBtn.textContent = 'Pause';
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
updateDisplay(depthAtTime(0));
