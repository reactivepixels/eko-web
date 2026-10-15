/**
 * EKO Mini Player: a mini player on a period desktop. The engine plays (gapless,
 * normalized); the shared media-session binding puts the track on the lock screen and wires
 * the keyboard's media keys; everything else here is the desktop around it.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { attachMediaSession } from "../../../dist/media-session.js";
import { filesToEntries, isAudioFile } from "../shared/files.js";
import { setFiles } from "../shared/synth.js";
import {
  clampWindow,
  createBalloons,
  createTransport,
  dismissBalloon,
  formatClock,
  formatTime,
  isPlaying,
  parseTitle,
  showBalloon,
  spectrumBars,
  tickBalloons,
  transportEvent,
  transportLabel,
} from "./lib/shell.js";

const $ = (sel) => document.querySelector(sel);
const os = $("#os");
const win = $("#win");

const engine = new EkoWebEngine({ normalize: true, transition: "gapless" });
engine.setVolume(0.7);
if (navigator.audioSession) navigator.audioSession.type = "playback";

/* ------------------------------------------------------------------ playlist */

let entries = [];
let nextId = 0;
let loadToken = 0;
/** What the window shows, kept in step with the engine's own events (see below). */
const local = createTransport();

const meta = (entry) => (entry ? { ...parseTitle(entry.title), entry } : null);
const byId = new Map();

// Lock screen and media keys. The binding follows gapless track changes itself; it only
// needs to be told what each track is called.
attachMediaSession(engine, {
  metadata: (track) => {
    const m = meta(byId.get(track.id));
    return m ? { title: m.title, artist: m.artist || "EKO Mini Player", album: m.album } : {};
  },
});

/** The load in flight (a drop, the picker or the demo), so Play can wait for it. */
let loading = null;
function track(job) {
  loading = job;
  job.finally(() => {
    if (loading === job) loading = null;
  });
  return job;
}

/** Load files as the playlist. Resolves true only if they replaced it. */
function load(files, opts) {
  return track(loadNow(files, opts));
}

async function loadNow(files, { autoplay = true } = {}) {
  if (!files.some(isAudioFile)) {
    say("No audio in that.");
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
  if (!added.length) return false;
  const old = entries;
  entries = added;
  byId.clear();
  for (const e of entries) byId.set(e.track.id, e);
  engine.setQueue(
    entries.map((e) => e.track),
    0,
  );
  attach();
  old.forEach((e) => URL.revokeObjectURL(e.url));
  transportEvent(local, "stop");
  local.ended = false;
  showWindow();
  if (autoplay) await play();
  return true;
}

/** The Ember Set renders once, however many presses ask for it at the same time. */
let demoFiles = null;
function demo() {
  demoFiles ??= (async () => {
    say("Preparing the Ember Set");
    await new Promise(requestAnimationFrame);
    return setFiles();
  })();
  return demoFiles;
}

async function play() {
  // Safari only starts audio inside the gesture: wake the context before any await.
  engine.context.resume().catch(() => {});
  if (!entries.length) {
    // Files dropped a moment ago may still be loading: wait for them rather than replace
    // them with the demo. Only an empty player with nothing on the way gets the Ember Set.
    if (!loading) track(demo().then((files) => loadNow(files, { autoplay: false })));
    await loading;
    if (!entries.length) return;
  }
  // Off the end of the queue, Play starts it over. A seek or skip since then (Previous)
  // clears this, so Play plays what you went back to.
  if (local.ended) engine.skipTo(0);
  const wasStopped = local.stopped;
  local.stopped = false;
  local.paused = false;
  local.ended = false;
  // The first track of a queue has no trackchange to announce it: do it here.
  if (wasStopped) announce(engine.currentIndex);
  await engine.play();
  if (engine.context.state !== "running") {
    transportEvent(local, "stop");
    say("Press play to start");
  }
}

const transport = {
  toggle: () => (local.stopped ? play() : transport.pause()),
  pause: () => {
    if (local.stopped) return;
    // Set now, then the engine's event confirms it (a pause during a load only lands later).
    local.paused = !local.paused;
    if (local.paused) engine.pause();
    else engine.play();
  },
  stop: () => {
    // Stopped first, so the engine's "pause" event reads as part of the stop.
    transportEvent(local, "stop");
    engine.pause();
    engine.seek(0);
  },
  prev: () => {
    if (!entries.length) return;
    transportEvent(local, "moved");
    if (engine.currentTime > 3 || engine.currentIndex === 0) engine.seek(0);
    else engine.previous();
    if (!local.stopped && !local.paused) engine.play();
  },
  next: () => {
    if (!entries.length || engine.currentIndex >= entries.length - 1) return;
    transportEvent(local, "moved");
    engine.next();
    if (!local.stopped && !local.paused) engine.play();
  },
  demo: () => {
    engine.context.resume().catch(() => {});
    return track(demo().then((files) => loadNow(files)));
  },
  open: () => {
    engine.context.resume().catch(() => {});
    picker.click();
  },
  mute: () => engine.setMuted(!engine.muted),
  show: () => showWindow(),
};

// The engine's own events are the truth: the media keys and the lock screen call the engine
// directly, and a pause key must show as paused here too.
engine.on("play", () => transportEvent(local, "play"));
engine.on("pause", () => transportEvent(local, "pause"));
engine.on("ended", () => transportEvent(local, "ended"));
engine.on("error", ({ error }) => {
  if (error.code === "prefetch_failed") return;
  // A failed skip can roll back and keep the old track playing: only a silent engine stops.
  if (error.code === "autoplay_blocked" || (engine.state === "error" && engine.paused)) {
    transportEvent(local, "stop");
  }
  say(error.code === "autoplay_blocked" ? "Press play to start" : `Cannot play (${error.code})`);
});
engine.on("trackchange", ({ index }) => announce(index));

/* ------------------------------------------------------------------ analyser */

let analyser = null;
let freq = new Uint8Array(1024);
const BARS = 38;
const levels = new Float32Array(BARS);
const peaks = new Float32Array(BARS);
const peakFall = new Float32Array(BARS);
const targets = new Float32Array(BARS);

function attach() {
  if (analyser) return;
  analyser = engine.analyser;
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  freq = new Uint8Array(analyser.frequencyBinCount);
}

/* ------------------------------------------------------------------ the window */

const pos = { x: 206, y: 96 };
let minimized = false;
let closed = false;

function deskSize() {
  const d = $("#desktop");
  return { w: d.clientWidth, h: d.clientHeight };
}

function place() {
  const c = clampWindow({ ...pos, w: win.offsetWidth, h: win.offsetHeight }, deskSize());
  pos.x = c.x;
  pos.y = c.y;
  win.style.left = `${pos.x}px`;
  win.style.top = `${pos.y}px`;
}

/** Where the window shrinks to: its taskbar button. */
function aimAtTaskButton() {
  const b = $("#taskBtn").getBoundingClientRect();
  const w = win.getBoundingClientRect();
  win.style.setProperty("--tx", `${(b.left + b.width / 2 - w.left) / z}px`);
  win.style.setProperty("--ty", `${(b.top + b.height / 2 - w.top) / z}px`);
}

/** If focus is inside the window as it goes away, hand it to `to` rather than lose it. */
function rescueFocus(to) {
  if (win.contains(document.activeElement)) to.focus({ preventScroll: true });
}

function setMinimized(on) {
  aimAtTaskButton();
  minimized = on;
  win.classList.toggle("min", on);
  // A minimized window is only invisible: inert keeps Tab and screen readers out of it too.
  win.inert = on;
  if (on) rescueFocus($("#taskBtn"));
  setActive(!on);
}

function showWindow() {
  closed = false;
  win.hidden = false;
  $("#taskBtn").hidden = false;
  setMinimized(false);
  activate();
  place();
}

function closeWindow() {
  transport.stop();
  rescueFocus($("#startBtn"));
  closed = true;
  win.hidden = true;
  $("#taskBtn").hidden = true;
}

/** The taskbar button reads pressed only while its window is the active one. */
function setActive(on) {
  win.classList.toggle("inactive", !on);
  $("#taskBtn").setAttribute("aria-pressed", String(on && !minimized));
}
const activate = () => setActive(true);

$("#minBtn").addEventListener("click", () => setMinimized(true));
$("#closeBtn").addEventListener("click", closeWindow);
$("#taskBtn").addEventListener("click", () => {
  if (minimized) {
    setMinimized(false);
    activate();
  } else if (win.classList.contains("inactive")) {
    activate();
  } else {
    setMinimized(true);
  }
});
win.addEventListener("pointerdown", activate);

// Drag by the title bar, kept on the desktop.
$("#titlebar").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button") || matchMedia("(max-width: 560px)").matches) {
    return;
  }
  e.preventDefault();
  const bar = e.currentTarget;
  bar.setPointerCapture(e.pointerId);
  const sx = e.clientX;
  const sy = e.clientY;
  const start = { ...pos };
  const move = (ev) => {
    pos.x = start.x + (ev.clientX - sx) / z;
    pos.y = start.y + (ev.clientY - sy) / z;
    place();
  };
  const end = () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", end);
    bar.removeEventListener("pointercancel", end);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
});

/* ------------------------------------------------------------------ desktop */

// Icons select on a click and open on a double-click (or Enter), as they did.
const iconActs = {
  music: () => transport.open(),
  player: () => showWindow(),
  computer: () => say("Nothing to see in here."),
  bin: () => say("The Recycle Bin is empty."),
};
for (const icon of document.querySelectorAll(".dicon")) {
  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".dicon.sel").forEach((x) => x.classList.remove("sel"));
    icon.classList.add("sel");
    if (e.detail === 0) iconActs[icon.dataset.icon]();
  });
  icon.addEventListener("dblclick", () => iconActs[icon.dataset.icon]());
}
$("#desktop").addEventListener("pointerdown", (e) => {
  if (e.target.closest(".win, .startmenu, .balloon, .dicon")) return;
  document.querySelectorAll(".dicon.sel").forEach((x) => x.classList.remove("sel"));
  setActive(false);
  closeStart();
});

/* ------------------------------------------------------------------ start menu */

const startBtn = $("#startBtn");
const startMenu = $("#startMenu");
function closeStart() {
  startMenu.hidden = true;
  startBtn.setAttribute("aria-expanded", "false");
}
startBtn.addEventListener("click", () => {
  const open = startMenu.hidden;
  startMenu.hidden = !open;
  startBtn.setAttribute("aria-expanded", String(open));
  if (open) startMenu.querySelector("button")?.focus({ preventScroll: true });
});
startMenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  closeStart();
  run(b.dataset.act);
});

/* ------------------------------------------------------------------ tray balloon */

const balloons = createBalloons();

function announce(index) {
  const m = meta(entries[index]);
  if (!m) return;
  const who = m.artist ? `${m.artist} - ${m.title}` : m.title;
  const from = [m.album && `from ${m.album}`, formatTime(m.entry.durationSec)]
    .filter(Boolean)
    .join(" · ");
  showBalloon(balloons, { who, from }, m.entry.track.id, performance.now());
  renderBalloon();
  // Screen readers hear it from a region that is always there: the balloon itself comes and
  // goes, and a live region that was hidden when it changed is often not announced.
  setText($("#announce"), `Now playing: ${who}`);
}

function renderBalloon() {
  const b = balloons.current;
  $("#balloon").hidden = !b;
  if (!b) return;
  const body = $("#balloonBody");
  body.textContent = "Now playing: ";
  const strong = document.createElement("b");
  strong.textContent = b.who;
  const small = document.createElement("small");
  small.textContent = b.from;
  body.append(strong, small);
}

$("#balloonClose").addEventListener("click", () => {
  dismissBalloon(balloons);
  renderBalloon();
});

/* ------------------------------------------------------------------ controls */

const picker = Object.assign(document.createElement("input"), {
  type: "file",
  multiple: true,
  accept: "audio/*",
  hidden: true,
});
document.body.append(picker);
picker.addEventListener("change", () => {
  if (picker.files.length) load([...picker.files]);
  picker.value = "";
});

function run(act) {
  Promise.resolve(transport[act]?.()).catch((err) =>
    say(`Cannot play (${err?.code || err?.name || "error"})`),
  );
}

for (const b of document.querySelectorAll(".win [data-act], .tray [data-act]")) {
  b.addEventListener("click", () => run(b.dataset.act));
}

let seeking = false;
const seek = $("#seek");
seek.addEventListener("input", () => {
  seeking = true;
  const d = engine.duration || 0;
  showSeek(Number(seek.value) / 1000, (Number(seek.value) / 1000) * d, d);
});
seek.addEventListener("change", () => {
  const d = engine.duration || 0;
  transportEvent(local, "moved");
  if (d > 0) engine.seek((Number(seek.value) / 1000) * d);
  seeking = false;
});

let volume = 70;
const vol = $("#vol");
vol.addEventListener("input", () => {
  volume = Number(vol.value);
  engine.setVolume(volume / 100);
  if (engine.muted) engine.setMuted(false);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") return closeStart();
  if (e.key !== " ") return;
  if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  run("toggle");
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

/* ------------------------------------------------------------------ rendering */

/**
 * Write text only when it changes. Assigning textContent replaces the text node even when
 * the value is the same, and a status region can re-announce on every frame.
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

let sayUntil = 0;
let sayText = "";
function say(text) {
  sayText = text;
  sayUntil = performance.now() + 3000;
}

function showSeek(frac, cur, dur) {
  const p = `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)}%`;
  $("#seekFill").style.width = p;
  $("#seekThumb").style.left = p;
  setText($("#cur"), formatTime(cur));
  setText($("#total"), formatTime(dur));
}

const canvas = $("#spectrum");
const g = canvas.getContext("2d");

function sizeCanvas() {
  const k = z * Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * k);
  canvas.height = Math.round(canvas.clientHeight * k);
}

function drawSpectrum() {
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  const unit = H / 34;
  const seg = 3 * unit;
  const gapY = 1 * unit;
  const rows = Math.floor(H / (seg + gapY));
  const step = W / BARS;
  const bw = step * 0.75;
  for (let i = 0; i < BARS; i++) {
    const x = i * step;
    const on = Math.round(levels[i] * rows);
    for (let r = 0; r < rows; r++) {
      const y = H - (r + 1) * (seg + gapY) + gapY;
      const f = r / rows;
      g.fillStyle =
        r < on ? (f > 0.78 ? "#e8f6ff" : f > 0.5 ? "#7cc8ff" : "#3a8fe8") : "rgba(80,130,210,.10)";
      g.fillRect(x, y, bw, seg);
    }
    const p = Math.round(peaks[i] * rows);
    if (p > 0) {
      g.fillStyle = "#ffffff";
      g.fillRect(x, H - (p + 1) * (seg + gapY) + gapY, bw, unit);
    }
  }
}

function render(dt, now) {
  const playing = isPlaying(local);
  os.classList.toggle("playing", playing);
  os.classList.toggle("muted", engine.muted);
  $("#muteBtn").setAttribute("aria-pressed", String(engine.muted));
  const label = playing ? "Pause" : "Play";
  $("#playBtn").setAttribute("aria-label", label);
  $("#trayPlay").setAttribute("aria-label", label);

  if (analyser && playing) {
    analyser.getByteFrequencyData(freq);
    spectrumBars(freq, analyser.context.sampleRate, analyser.fftSize, BARS, targets);
  } else {
    targets.fill(0);
  }
  for (let i = 0; i < BARS; i++) {
    // Analyser bytes are already in dB: stretch the useful top of the range across the bars.
    const t = Math.max(0, Math.min(1, (targets[i] - 0.3) / 0.62));
    levels[i] = t > levels[i] ? t : Math.max(t, levels[i] - dt * 2.2);
    if (levels[i] >= peaks[i]) {
      peaks[i] = levels[i];
      peakFall[i] = 0;
    } else {
      peakFall[i] += dt * 1.6;
      peaks[i] = Math.max(0, peaks[i] - peakFall[i] * dt);
    }
  }
  drawSpectrum();

  const i = engine.currentIndex;
  const m = meta(entries[i]);
  const dur = engine.duration || m?.entry.durationSec || 0;
  const cur = local.stopped && engine.currentTime === 0 ? 0 : engine.currentTime;
  const lamp = $("#lamp");
  lamp.className = playing ? "on" : local.paused ? "paused" : "";
  const state = transportLabel(local, entries.length > 0);
  setText($("#lab"), now < sayUntil ? sayText : playing ? "Now playing" : state);
  if (m) {
    setText($("#song"), m.title);
    setText($("#art"), [m.artist, m.album].filter(Boolean).join(" · ") || "Unknown artist");
    setText($("#time"), formatTime(cur));
    setText($("#rem"), dur ? `-${formatTime(dur - cur)}` : "");
    setText($("#kbps"), m.entry.kbps ? `${m.entry.kbps} kbps` : "--- kbps");
    setText($("#trackNo"), `Track ${i + 1} of ${entries.length}`);
  }
  if (analyser) setText($("#khz"), `${Math.round(analyser.context.sampleRate / 1000)} kHz`);
  setText($("#state"), state);
  if (!seeking) {
    showSeek(dur ? cur / dur : 0, cur, dur);
    seek.value = String(dur ? Math.round((cur / dur) * 1000) : 0);
    seek.setAttribute("aria-valuetext", `${formatTime(cur)} of ${formatTime(dur)}`);
  }
  const v = engine.muted ? 0 : Math.round(engine.volume * 100);
  $("#volFill").style.width = `${v}%`;
  $("#volThumb").style.left = `${v}%`;
  if (document.activeElement !== vol) vol.value = String(volume);

  if (tickBalloons(balloons, now)) renderBalloon();
}

let lastClock = "";
function tickClock() {
  const t = formatClock(new Date());
  if (t !== lastClock) {
    lastClock = t;
    $("#clock").textContent = t;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  render(dt, now);
  tickClock();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ scale */

let z = 1;
function fit() {
  // Big screens get the desktop at 1.25x to 2x in quarter steps, so the 11px world stays crisp
  // and in proportion. Phones keep 1x.
  const raw = Math.min(innerWidth / 1000, innerHeight / 720);
  z = innerWidth <= 560 ? 1 : Math.max(1, Math.min(2, Math.floor(raw * 4) / 4));
  document.documentElement.style.setProperty("--z", String(z));
  sizeCanvas();
  if (!closed) place();
}
addEventListener("resize", fit);

addEventListener("pagehide", (e) => {
  if (!e.persisted) entries.forEach((entry) => URL.revokeObjectURL(entry.url));
});

fit();
// Start the window centred on the first visit.
const d = deskSize();
pos.x = Math.round((d.w - win.offsetWidth) / 2);
pos.y = Math.round(Math.max(24, (d.h - win.offsetHeight) / 2 - 40));
place();
tickClock();
requestAnimationFrame(frame);
document.documentElement.dataset.ready = "1";

/** For poking from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ engine, entries, local, balloons, pos });
