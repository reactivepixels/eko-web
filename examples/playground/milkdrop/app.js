/**
 * EKO Visuals: a MilkDrop-style visualizer on the engine's analyser. The engine plays and
 * normalizes; this page reads its analyser each frame, turns it into bass, mid and treb,
 * runs the current preset's equations, and hands the result to the WebGL feedback loop.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { filesToEntries, isAudioFile } from "../shared/files.js";
import { setFiles } from "../shared/synth.js";
import { BANDS, bandEnergy, createAnalysis, stepAnalysis } from "./audio/analysis.js";
import { drawWaves } from "./draw/waves.js";
import { createRenderer } from "./gl/renderer.js";
import { blend, BLEND_SECONDS, evaluate, pickNext, presetFile, PRESETS } from "./presets.js";

const $ = (sel) => document.querySelector(sel);
const view = $(".view");

const engine = new EkoWebEngine({ normalize: true, transition: "gapless" });
if (navigator.audioSession) navigator.audioSession.type = "playback";

/* ------------------------------------------------------------------ playlist */

let entries = [];
let nextId = 0;
let loadToken = 0;
const local = { stopped: true, paused: false };

/** Load files as the new playlist. Resolves true only if they actually replaced it. */
async function load(files, { autoplay = true } = {}) {
  // A drop with no audio in it must not cancel a load that has some.
  if (!files.some(isAudioFile)) {
    flash("no audio in that");
    return false;
  }
  const token = ++loadToken;
  const idStart = nextId;
  nextId += files.length;
  const added = await filesToEntries(files, idStart);
  if (token !== loadToken) {
    added.forEach((e) => URL.revokeObjectURL(e.url));
    return false;
  }
  if (!added.length) {
    flash("no audio in that");
    return false;
  }
  const old = entries;
  entries = added;
  engine.setQueue(
    entries.map((e) => e.track),
    0,
  );
  attach();
  old.forEach((e) => URL.revokeObjectURL(e.url));
  local.stopped = true;
  local.paused = false;
  if (autoplay) await play();
  return true;
}

/** The generated set is a second of work: make it once, after saying so. */
let demoFiles = null;
async function demo() {
  if (!demoFiles) {
    flash("rendering the ember set");
    await new Promise(requestAnimationFrame);
    demoFiles = setFiles();
  }
  return demoFiles;
}

async function play() {
  // Safari only starts audio inside the gesture: wake the context before any await.
  engine.context.resume().catch(() => {});
  if (!entries.length) {
    const loaded = await load(await demo(), { autoplay: false });
    if (!loaded) return;
    flash("ember set: four tracks, one continuous piece");
  }
  if (engine.state === "ended") engine.skipTo(0);
  local.stopped = false;
  local.paused = false;
  await engine.play();
  // A drop is not a gesture the browser will start audio for: if it stayed asleep, say so
  // rather than show a pause button over silence.
  if (engine.context.state !== "running") {
    local.stopped = true;
    flash("press play to start");
  }
}

const transport = {
  play: () => play(),
  toggle: () => (local.stopped ? play() : transport.pause()),
  pause: () => {
    if (local.stopped) return;
    local.paused = !local.paused;
    if (local.paused) engine.pause();
    else engine.play();
  },
  stop: () => {
    engine.pause();
    engine.seek(0);
    local.stopped = true;
    local.paused = false;
  },
  prev: () => {
    if (!entries.length) return;
    manualSkip = true;
    if (engine.currentTime > 3 || engine.currentIndex === 0) engine.seek(0);
    else engine.previous();
    if (!local.stopped && !local.paused) engine.play();
  },
  next: () => {
    if (!entries.length || engine.currentIndex >= entries.length - 1) return;
    manualSkip = true;
    engine.next();
    if (!local.stopped && !local.paused) engine.play();
  },
};

engine.on("ended", () => {
  local.stopped = true;
  local.paused = false;
});
engine.on("error", ({ error }) => {
  if (error.code === "prefetch_failed") return;
  if (error.code === "autoplay_blocked" || engine.state === "error") {
    local.stopped = true;
    local.paused = false;
  }
  flash(
    error.code === "autoplay_blocked"
      ? "press play to start"
      : `could not play that (${error.code})`,
  );
});

/** How the last track boundary went: gapless, a gap, or a skip you asked for. */
let manualSkip = false;
let boundary = "gapless";
engine.on("trackchange", ({ transition }) => {
  boundary = manualSkip ? "skip" : transition;
  manualSkip = false;
});

/* ------------------------------------------------------------------ analyser */

let analyser = null;
let freq = new Uint8Array(1024);
const wave = new Float32Array(1024);
const analysis = createAnalysis();

/** Reading engine.context creates the AudioContext: only after a gesture, via load(). */
function attach() {
  if (analyser) return;
  analyser = engine.analyser;
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.5;
  freq = new Uint8Array(analyser.frequencyBinCount);
}

/* ------------------------------------------------------------------ presets */

const presets = {
  current: Math.floor(Math.random() * PRESETS.length),
  previous: -1,
  blendFrom: -1,
  /** The picture being blended away from, frozen at the moment of the switch. */
  fromParams: null,
  blendStart: 0,
  locked: false,
  history: [],
  nextAuto: 0,
};

/** Switch preset: blended (MilkDrop's soft transition) or a hard cut. */
function goTo(index, { hard = false, remember = true } = {}, now = clock) {
  if (index === presets.current) return;
  if (remember) presets.history.push(presets.current);
  if (presets.history.length > 30) presets.history.shift();
  presets.blendFrom = hard ? -1 : presets.current;
  // Blend from what is on screen now, even if that is itself halfway through a blend.
  presets.fromParams = hard || !lastParams ? null : lastParams;
  presets.blendStart = now;
  presets.current = index;
  presets.nextAuto = now + 18 + Math.random() * 12;
  showPreset();
}

const presetActs = {
  presetNext: (hard = false) => goTo(pickNext(presets.current), { hard }),
  presetPrev: () => {
    const back = presets.history.pop();
    if (back !== undefined) goTo(back, { remember: false });
  },
  lock: () => {
    presets.locked = !presets.locked;
    $("#lockBtn").setAttribute("aria-pressed", String(presets.locked));
    flash(presets.locked ? "preset locked" : "preset unlocked");
  },
};

/* ------------------------------------------------------------------ OSD */

let msgTimer = 0;
function flash(text) {
  const el = $("#msg");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove("on"), 1800);
}

function showPreset() {
  const cur = PRESETS[presets.current];
  const blending = presets.blendFrom >= 0 && clock - presets.blendStart < BLEND_SECONDS;
  $("#preset").textContent = blending
    ? `${PRESETS[presets.blendFrom].name} + ${presetFile(cur)}`
    : presetFile(cur);
  $("#rating").textContent =
    `rating: ${cur.rating}  |  blend ${BLEND_SECONDS.toFixed(1)}s${presets.locked ? "  |  locked" : ""}`;
}

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function showTrack() {
  const playing = !local.stopped && !local.paused;
  view.classList.toggle("playing", playing);
  $("#playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
  const i = engine.currentIndex;
  const entry = entries[i];
  if (entry) {
    $("#song").textContent = `${String(i + 1).padStart(2, "0")}. ${entry.title}`;
    $("#time").textContent =
      `${fmt(engine.currentTime)} / ${fmt(engine.duration || entry.durationSec)}`;
  }
  $("#bpm").textContent = analysis.bpm ? `${analysis.bpm} bpm` : "";
  $("#gapless").textContent = boundary;
  if (analyser) {
    const rate = analyser.context.sampleRate;
    const norm = engine.config.normalize ? `${engine.config.targetLufs} LUFS` : "norm off";
    $("#format").textContent = `${(rate / 1000).toFixed(1)} kHz   ${norm}`;
  }
}

/* ------------------------------------------------------------------ render loop */

const canvas = $("#gl");
let renderer = safeRenderer();
let glLost = false;

/** A driver that cannot compile the shaders gets the "no WebGL" message, not a dead page. */
function safeRenderer() {
  try {
    return createRenderer(canvas);
  } catch {
    return null;
  }
}

// A GPU reset (sleep, a driver crash, a GPU switch) loses the context: ask for it back, and
// rebuild everything when it returns.
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  glLost = true;
});
canvas.addEventListener("webglcontextrestored", () => {
  renderer = safeRenderer();
  glLost = !renderer;
  size();
});
const waves = document.createElement("canvas");
const wavesCtx = waves.getContext("2d");
let clock = 0;

function size() {
  if (!innerWidth || !innerHeight) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  // One scale for both sides, so the picture keeps the window's shape.
  const cw = innerWidth * dpr;
  const ch = innerHeight * dpr;
  const k = Math.min(1, 2560 / Math.max(cw, ch));
  canvas.width = Math.round(cw * k);
  canvas.height = Math.round(ch * k);
  // The feedback runs under screen resolution: smoke does not need every pixel, and the
  // frame rate does. Capped on the longer side, so a tall window costs no more than a wide one.
  const f = Math.min(0.75, 1280 / Math.max(cw, ch));
  const fw = Math.max(16, Math.round(cw * f));
  const fh = Math.max(16, Math.round(ch * f));
  waves.width = fw;
  waves.height = fh;
  renderer?.resize(fw, fh);
}

// Moving to a screen with a different pixel density does not fire a resize.
function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      size();
      watchDpr();
    },
    { once: true },
  );
}

let lastParams = null;
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let osdTime = 0;
const bars = [...document.querySelectorAll("#bars i")];

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  clock += dt;

  if (analyser) {
    analyser.getByteFrequencyData(freq);
    analyser.getFloatTimeDomainData(wave);
  }
  const rate = analyser?.context.sampleRate ?? 48000;
  const fft = analyser?.fftSize ?? 2048;
  stepAnalysis(
    analysis,
    {
      bass: bandEnergy(freq, rate, fft, BANDS.bass),
      mid: bandEnergy(freq, rate, fft, BANDS.mid),
      treb: bandEnergy(freq, rate, fft, BANDS.treb),
    },
    dt,
    clock,
  );

  if (!presets.locked && clock >= presets.nextAuto) {
    // Sometimes a hard cut lands on a beat, the way MilkDrop does it.
    goTo(pickNext(presets.current), { hard: analysis.beat && Math.random() < 0.3 });
  }

  const f = {
    t: clock,
    bass: analysis.now.bass,
    mid: analysis.now.mid,
    treb: analysis.now.treb,
    bass_att: analysis.att.bass,
    mid_att: analysis.att.mid,
    treb_att: analysis.att.treb,
    beat: analysis.beat,
  };
  let params = evaluate(PRESETS[presets.current], f);
  if (presets.blendFrom >= 0) {
    const k = (clock - presets.blendStart) / BLEND_SECONDS;
    if (k < 1 && presets.fromParams) params = blend(presets.fromParams, params, k);
    else if (k >= 1) {
      presets.blendFrom = -1;
      presets.fromParams = null;
      showPreset();
    }
  }
  lastParams = params;

  if (renderer && !glLost) {
    drawWaves(wavesCtx, params, { wave, spectrum: freq, t: clock, ...f });
    renderer.frame(params, waves, clock);
  }

  fpsFrames += 1;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    $("#fps").textContent = `${(fpsFrames / fpsTime).toFixed(2)} fps`;
    fpsFrames = 0;
    fpsTime = 0;
  }
  osdTime += dt;
  if (osdTime >= 0.25) {
    osdTime = 0;
    showTrack();
    if (presets.blendFrom >= 0) showPreset();
  }
  bars.forEach((b, i) => {
    const level = [f.bass, f.bass_att, f.mid, f.mid_att, f.treb][i];
    b.style.height = `${Math.max(1, Math.round(2 + Math.min(7, (level - 0.6) * 6)))}px`;
  });

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ input */

const picker = Object.assign(document.createElement("input"), {
  type: "file",
  multiple: true,
  accept: "audio/*",
  hidden: true,
});
document.body.append(picker);
picker.addEventListener("change", () => {
  load([...picker.files]);
  picker.value = "";
});

function openFiles() {
  engine.context.resume().catch(() => {});
  picker.click();
}

const fullscreenOk = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
if (!fullscreenOk) document.querySelector('[data-act="full"]').hidden = true;

function toggleFull() {
  const root = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    const go = root.requestFullscreen || root.webkitRequestFullscreen;
    Promise.resolve(go?.call(root)).catch(() => {});
  }
}

function toggleHelp() {
  const help = $("#help");
  help.hidden = !help.hidden;
}

function run(act, arg) {
  const all = {
    ...transport,
    ...presetActs,
    open: openFiles,
    full: toggleFull,
    help: toggleHelp,
  };
  Promise.resolve(all[act]?.(arg)).catch((err) =>
    flash(`could not play (${err?.code || err?.name})`),
  );
}

for (const b of document.querySelectorAll(".dock [data-act]")) {
  b.addEventListener("click", () => run(b.dataset.act));
}

const KEYS = {
  " ": ["presetNext"],
  h: ["presetNext", true],
  backspace: ["presetPrev"],
  l: ["lock"],
  z: ["prev"],
  x: ["play"],
  c: ["pause"],
  v: ["stop"],
  b: ["next"],
  o: ["open"],
  f: ["full"],
  "?": ["help"],
  f1: ["help"],
  escape: ["helpClose"],
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((k === " " || k === "enter") && e.target instanceof HTMLButtonElement) return;
  const hit = KEYS[k];
  if (!hit) return;
  e.preventDefault();
  if (hit[0] === "helpClose") $("#help").hidden = true;
  else run(hit[0], hit[1]);
  wake();
});

for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  engine.context.resume().catch(() => {});
  load([...e.dataTransfer.files]);
});

// The controls fade out while you watch, and come back when you move.
let idleTimer = 0;
function wake() {
  view.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Keyboard users keep the controls: only a visible focus ring holds them on screen.
    if (!document.querySelector(":focus-visible") && $("#help").hidden) view.classList.add("idle");
  }, 2600);
}
for (const type of ["pointermove", "pointerdown", "focusin"]) document.addEventListener(type, wake);

addEventListener("resize", size);
watchDpr();
addEventListener("pagehide", (e) => {
  if (!e.persisted) entries.forEach((entry) => URL.revokeObjectURL(entry.url));
});

/* ------------------------------------------------------------------ start */

if (!renderer) {
  $("#song").textContent = "This visualizer needs WebGL 2, which this browser does not have.";
} else {
  size();
  presets.nextAuto = 22;
  showPreset();
  wake();
  requestAnimationFrame(frame);
}
document.documentElement.dataset.ready = "1";

/** For poking from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ engine, presets, analysis, entries });
