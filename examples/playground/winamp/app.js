/**
 * EKO-AMP: the only module that talks to the engine. Windows get a plain state object each
 * frame and hand back actions; this file turns those actions into engine calls.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { appendEntries, filesToEntries, makeDemoLoop } from "../shared/files.js";
import { createEqChain, PRESETS } from "./audio/eq-chain.js";
import {
  BAR_COUNT,
  barRanges,
  binsToBars,
  createPeaks,
  SCOPE_WIDTH,
  scopePoints,
} from "./audio/vis.js";
import { paintBaseSkin } from "./skin/base-skin.js";
import { createEqWindow } from "./windows/equalizer.js";
import { createMainWindow } from "./windows/main.js";
import { createPlaylistWindow, maxScroll, VISIBLE_ROWS } from "./windows/playlist.js";
import { createWindowManager } from "./wm/window-manager.js";

const skin = paintBaseSkin();
const engine = new EkoWebEngine({ normalize: true, transition: "gapless" });
engine.setVolume(0.75);

/** Every entry in the playlist window. */
let entries = [];
/**
 * The entries the engine's queue was last built from. setQueue() cuts whatever is playing,
 * so files added mid-song wait here as a difference between `entries` and `queued`, and are
 * applied at the next natural boundary (end of queue, a skip, a stop) instead.
 */
let queued = [];
let nextId = 0;

const local = {
  stopped: true,
  paused: false,
  showRemaining: false,
  visMode: "spectrum",
  selection: { index: -1, scroll: 0 },
  error: null,
  flash: null,
  flashUntil: 0,
  presetIndex: 0,
};
/** EQ settings are kept here so they survive until the audio graph exists. */
const eqModel = { on: true, auto: false, preamp: 0, bands: Array(10).fill(0), balance: 0 };

let eq = null;
let analyser = null;
let ranges = null;
let freqData = null;
let waveData = null;
const peaks = createPeaks();
const bars = new Float32Array(BAR_COUNT);
const scope = new Uint8Array(SCOPE_WIDTH).fill(8);

/**
 * The EQ chain and the analyser tap. Reading engine.context creates the AudioContext, so this
 * runs only once there is a queue, which only happens after a click, drop or key press. The
 * play actions also touch engine.context directly, but only from inside a click or key press.
 */
function attachAudio() {
  if (eq) return;
  eq = createEqChain(engine.context);
  eq.setOn(eqModel.on);
  eq.setPreamp(eqModel.preamp);
  eqModel.bands.forEach((db, i) => eq.setBand(i, db));
  eq.setBalance(eqModel.balance);
  engine.setInserts(eq.nodes());
  analyser = engine.analyser;
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.5;
  ranges = barRanges(engine.context.sampleRate, analyser.fftSize);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  waveData = new Uint8Array(analyser.fftSize);
}

const hasPending = () => queued !== entries;

/** The engine's position in `queued`, mapped to the playlist. -1 if that row was removed. */
const playingIndex = () => entries.indexOf(queued[engine.currentIndex]);

/** The playlist row of the nearest surviving queued track at or after queue position `qi`. */
function survivorFrom(qi) {
  for (let i = Math.max(0, qi); i < queued.length; i++) {
    const at = entries.indexOf(queued[i]);
    if (at >= 0) return at;
  }
  return -1;
}

/** The same, looking at or before `qi`. */
function survivorUpTo(qi) {
  for (let i = Math.min(qi, queued.length - 1); i >= 0; i--) {
    const at = entries.indexOf(queued[i]);
    if (at >= 0) return at;
  }
  return -1;
}

/** Where to rebuild the queue so playback carries on from the right row. */
function resumeIndex() {
  const at = survivorFrom(engine.currentIndex);
  return at >= 0 ? at : Math.max(0, Math.min(engine.currentIndex, entries.length - 1));
}

/** Rebuild the engine's queue from the playlist, starting at `index`. */
function applyQueue(index) {
  const dropped = queued.filter((e) => !entries.includes(e));
  queued = entries;
  if (entries.length === 0) {
    engine.setQueue([]);
  } else {
    engine.setQueue(
      entries.map((e) => e.track),
      Math.max(0, Math.min(index, entries.length - 1)),
    );
    attachAudio();
  }
  // Only now is nothing reading the removed files any more.
  dropped.forEach((e) => URL.revokeObjectURL(e.url));
}

async function addFiles(files) {
  const added = await filesToEntries(files, nextId);
  if (added.length === 0) return 0;
  nextId += added.length;
  const wasEmpty = entries.length === 0;
  entries = appendEntries(entries, added);
  if (wasEmpty) {
    local.selection.index = 0;
    applyQueue(0);
  } else if (local.stopped) {
    applyQueue(resumeIndex());
  }
  return added.length;
}

/** Nothing loaded: the generated loop, three times. The parts join with no seam. */
function demoParts() {
  const loop = makeDemoLoop();
  return [1, 2, 3].map(
    (n) => new File([loop], `EKO - Demo Loop (Part ${n}).wav`, { type: "audio/wav" }),
  );
}
let demoLoad = null;

async function play() {
  local.error = null;
  // Safari only lets audio start inside the gesture, so wake the context before any await.
  engine.context.resume().catch(() => {});
  if (entries.length === 0) {
    demoLoad ??= addFiles(demoParts()).finally(() => (demoLoad = null));
    await demoLoad;
  }
  if (hasPending()) applyQueue(resumeIndex());
  else if (engine.state === "ended") engine.seek(0);
  local.stopped = false;
  local.paused = false;
  await engine.play();
}

/** Skip with a pending queue: rebuild it at the target instead of skipping the stale one. */
function skip(delta) {
  if (!hasPending()) {
    if (delta < 0) engine.previous();
    else engine.next();
    return;
  }
  if (entries.length === 0) return;
  const at = playingIndex();
  let target;
  if (engine.shuffle && entries.length > 1) {
    do target = Math.floor(Math.random() * entries.length);
    while (target === at);
  } else if (at < 0) {
    target = resumeIndex();
  } else {
    target = at + delta;
  }
  if (target >= entries.length) {
    if (engine.repeat !== "all") return;
    target = 0;
  }
  applyQueue(Math.max(0, target));
  if (!local.stopped) {
    local.paused = false;
    engine.play();
  }
}

function flash(text) {
  local.flash = text;
  local.flashUntil = performance.now() + 1800;
}

function keepRowVisible(index) {
  const s = local.selection;
  if (index < s.scroll) s.scroll = index;
  if (index >= s.scroll + VISIBLE_ROWS) s.scroll = index - VISIBLE_ROWS + 1;
  s.scroll = Math.max(0, Math.min(s.scroll, maxScroll(entries.length)));
}

const actions = {
  play: () => play(),
  // Pause follows what the user asked for, not engine.paused: the engine also reports paused
  // while it decodes the next track, and a press then must still mean "pause".
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
    if (hasPending()) applyQueue(resumeIndex());
  },
  prev: () => skip(-1),
  next: () => skip(1),
  seek: ({ value }) => engine.seek(value),
  volume: ({ value }) => engine.setVolume(value),
  balance: ({ value }) => {
    eqModel.balance = value;
    eq?.setBalance(value);
  },
  shuffle: () => engine.setShuffle(!engine.shuffle),
  repeat: () => engine.setRepeat(engine.repeat === "all" ? "none" : "all"),
  select: ({ index }) => {
    local.selection.index = index;
  },
  playIndex: ({ index }) => {
    local.selection.index = index;
    if (hasPending()) applyQueue(index);
    else engine.skipTo(index);
    local.stopped = false;
    local.paused = false;
    local.error = null;
    engine.context.resume().catch(() => {});
    engine.play();
  },
  remove: () => {
    const idx = local.selection.index;
    if (idx < 0 || idx >= entries.length) return;
    const playingEntry = queued[engine.currentIndex];
    entries = entries.filter((_, i) => i !== idx);
    local.selection.index = Math.min(idx, entries.length - 1);
    keepRowVisible(Math.max(0, local.selection.index));
    // Removing the track that is playing stops it, like Winamp; anything else waits.
    if (playingEntry && !entries.includes(playingEntry)) {
      local.stopped = true;
      local.paused = false;
      applyQueue(Math.min(idx, entries.length - 1));
    } else if (local.stopped) {
      applyQueue(resumeIndex());
    }
  },
  scroll: ({ value }) => {
    local.selection.scroll = Math.max(0, Math.min(Math.round(value), maxScroll(entries.length)));
  },
  toggleEq: () => wm.setVisible("eq", !wm.isVisible("eq")),
  togglePl: () => wm.setVisible("pl", !wm.isVisible("pl")),
  toggleTime: () => {
    local.showRemaining = !local.showRemaining;
  },
  toggleVis: () => {
    const modes = ["spectrum", "scope", "off"];
    local.visMode = modes[(modes.indexOf(local.visMode) + 1) % modes.length];
  },
  eqOn: () => {
    eqModel.on = !eqModel.on;
    if (eq) {
      eq.setOn(eqModel.on);
      engine.setInserts(eq.nodes());
    }
  },
  eqAuto: () => {
    eqModel.auto = !eqModel.auto;
  },
  eqPreset: () => {
    const names = Object.keys(PRESETS);
    local.presetIndex = (local.presetIndex + 1) % names.length;
    const name = names[local.presetIndex];
    eqModel.preamp = PRESETS[name].preamp;
    eqModel.bands = [...PRESETS[name].bands];
    eq?.applyPreset(name);
    flash(`EQ PRESET: ${name}`);
  },
  preamp: ({ value }) => {
    eqModel.preamp = value;
    eq?.setPreamp(value);
  },
  eqBand: ({ index, value }) => {
    eqModel.bands[index] = value;
    eq?.setBand(index, value);
  },
  open: () => picker.click(),
  drop: ({ files }) => addFiles(files),
  noop: () => {},
};

function onAction(action) {
  const run = actions[action.type];
  if (!run) return;
  Promise.resolve(run(action)).catch((err) => {
    local.error = `*** ERROR: ${err?.code || err?.name || "PLAYBACK"} ***`;
  });
}

const desktop = document.getElementById("desktop");
const wm = createWindowManager({
  desktop,
  windows: [createMainWindow(skin), createEqWindow(skin), createPlaylistWindow(skin)],
  onAction,
  storageKey: "eko-amp:layout",
});

const picker = document.createElement("input");
picker.type = "file";
picker.multiple = true;
picker.accept = "audio/*";
picker.hidden = true;
picker.addEventListener("change", () => {
  addFiles([...picker.files]);
  picker.value = "";
});
document.body.appendChild(picker);

let lastIndex = -1;
engine.on("trackchange", ({ index }) => {
  const wrapped = !engine.shuffle && index === 0 && lastIndex === queued.length - 1;
  lastIndex = index;
  if (hasPending()) {
    // A track removed from the playlist came up in the stale queue: skip to the survivor.
    if (!entries.includes(queued[index])) {
      if (entries.length === 0) {
        local.stopped = true;
        applyQueue(0);
      } else {
        applyQueue(resumeIndex());
        engine.play();
      }
      return;
    }
    // Repeat-all wrapped the old list: play the files added since before starting over.
    if (wrapped) {
      const next = survivorUpTo(queued.length - 1) + 1;
      applyQueue(next < entries.length ? next : 0);
      engine.play();
      return;
    }
  }
  const shown = entries.indexOf(queued[index]);
  if (shown >= 0) keepRowVisible(shown);
});
engine.on("ended", () => {
  // The old queue ran out with files waiting after it: carry on into them.
  if (hasPending()) {
    const next = survivorUpTo(engine.currentIndex) + 1;
    if (next < entries.length) {
      applyQueue(next);
      engine.play();
      return;
    }
  }
  local.stopped = true;
  local.paused = false;
  // The engine leaves the position at the end; rewind so the next Play starts the track.
  engine.seek(0);
});
engine.on("error", ({ error }) => {
  local.error = `*** ERROR: ${error.code} ***`;
  local.stopped = true;
  local.paused = false;
});

const KEYS = {
  z: "prev",
  x: "play",
  c: "pause",
  v: "stop",
  b: "next",
  l: "open",
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
  const key = e.key.toLowerCase();
  if (KEYS[key]) {
    e.preventDefault();
    onAction({ type: KEYS[key] });
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    engine.seek(Math.max(0, engine.currentTime + (e.key === "ArrowLeft" ? -5 : 5)));
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    engine.setVolume(engine.volume + (e.key === "ArrowUp" ? 0.05 : -0.05));
  }
});

addEventListener("pagehide", () => entries.forEach((e) => URL.revokeObjectURL(e.url)));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const snap = engine.getSnapshot();
  const status = local.stopped ? "stopped" : local.paused ? "paused" : "playing";
  const entry = queued[snap.index] || null;
  const shownIndex = entry ? entries.indexOf(entry) : -1;

  if (analyser && status === "playing" && !snap.paused) {
    analyser.getByteFrequencyData(freqData);
    binsToBars(freqData, ranges, bars);
    analyser.getByteTimeDomainData(waveData);
    scopePoints(waveData, scope);
  } else {
    for (let i = 0; i < BAR_COUNT; i++) bars[i] = Math.max(0, bars[i] - dt * 40);
    scope.fill(8);
  }
  const peakLevels = peaks.update(bars, dt);

  const message = now < local.flashUntil ? local.flash : local.error;
  wm.render({
    now,
    status,
    error: message,
    time: {
      current: engine.currentTime,
      duration: snap.duration || entry?.durationSec || 0,
      showRemaining: local.showRemaining,
    },
    track: entry
      ? {
          index: shownIndex >= 0 ? shownIndex : snap.index,
          title: entry.title,
          kbps: entry.kbps,
          khz: eq ? engine.context.sampleRate / 1000 : null,
        }
      : null,
    playlist: entries,
    selection: local.selection,
    volume: snap.volume,
    balance: eqModel.balance,
    shuffle: snap.shuffle,
    repeat: snap.repeat === "all",
    eq: { on: eqModel.on, auto: eqModel.auto, preamp: eqModel.preamp, bands: eqModel.bands },
    vis: { mode: local.visMode, bars, peaks: peakLevels, scope },
    windows: { eq: wm.isVisible("eq"), pl: wm.isVisible("pl") },
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
