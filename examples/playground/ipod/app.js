/**
 * EKO Classic: a click-wheel player on the engine. The wheel turns into steps (wheel.js),
 * the steps move the menus (menu.js) or, on Now Playing, the volume and the scrubber, and
 * choosing a song hands the list it came from to the engine as a gapless queue.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { filesToEntries, isAudioFile } from "../shared/files.js";
import { setFiles } from "../shared/synth.js";
import { coverSvg } from "./art.js";
import { buildLibrary } from "./library.js";
import { createNav, cycleSetting, nowPlayingScreen, VISIBLE_ROWS } from "./menu.js";
import { angleOf, createTracker, onRing } from "./wheel.js";

const $ = (sel) => document.querySelector(sel);
const engine = new EkoWebEngine({ normalize: true, transition: "gapless" });
engine.setVolume(0.7);
if (navigator.audioSession) navigator.audioSession.type = "playback";

/* ------------------------------------------------------------------ state */

let library = buildLibrary([]);
let entries = [];
let nextId = 0;
let settings = { shuffle: 0, repeat: 0, clicker: 0 };
/** The songs the engine's queue was built from, in queue order. */
let queueSongs = [];
const local = { stopped: true, paused: false, hold: false, syncing: false, ended: false };
const np = { scrub: false, scrubPos: 0, scrubTimer: 0, volUntil: 0 };

const nav = createNav(() => ({ library, settings, nowPlaying: queueSongs.length > 0 }));

/* ------------------------------------------------------------------ screen */

const panes = $("#panes");
let pane = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The top menus split the screen with artwork, as the Classic did. */
const SPLIT = new Set(["main", "music", "settings"]);

function listPane() {
  const p = el("div", "pane list");
  p.append(el("div", "rows"));
  if (SPLIT.has(nav.screen.id) && library.albums.length) {
    p.classList.add("split");
    const side = el("div", "side");
    const album = library.albums[Math.floor(Math.random() * library.albums.length)];
    side.innerHTML = coverSvg(album.name, album.artist);
    p.append(side);
  }
  fillList(p);
  return p;
}

function fillList(p) {
  const s = nav.screen;
  const rows = nav.rows();
  const box = p.querySelector(".rows");
  box.innerHTML = "";
  rows.slice(s.top, s.top + VISIBLE_ROWS).forEach((row, i) => {
    const at = s.top + i;
    const r = el("div", "row");
    if (at === s.sel) r.classList.add("sel");
    if (row.chevron) r.classList.add("chev");
    if (!row.action) r.classList.add("quiet");
    r.append(el("span", "l", row.label));
    if (row.detail) r.append(el("span", "d", row.detail));
    box.append(r);
  });
  p.querySelector(".scrollbar")?.remove();
  if (rows.length > VISIBLE_ROWS) {
    box.style.right = "9px";
    const bar = el("div", "scrollbar");
    const thumb = el("i");
    const h = 217;
    thumb.style.height = `${Math.max(14, (VISIBLE_ROWS / rows.length) * h)}px`;
    thumb.style.top = `${(s.top / rows.length) * h}px`;
    bar.append(thumb);
    p.append(bar);
  } else {
    box.style.right = "0";
  }
  const sel = rows[s.sel];
  $("#ring").setAttribute(
    "aria-valuetext",
    sel ? `${s.title}: ${sel.label}${sel.detail ? `, ${sel.detail}` : ""}` : s.title,
  );
}

function nowPane() {
  const p = el("div", "pane np");
  p.innerHTML = `
    <div class="art"><div class="cover"></div><div class="reflect"></div></div>
    <div class="meta"><div class="n"></div><div class="ti"></div><div class="ar"></div><div class="al"></div></div>
    <div class="bar"><div class="track"><div class="fill"></div></div><div class="diamond"></div></div>
    <div class="times"><span class="el">0:00</span><span class="rem">-0:00</span></div>
    <div class="vol"><span class="spk"></span><span class="vtrack"><span class="vfill"></span></span><span class="spk loud"><i></i></span></div>`;
  p.dataset.song = "";
  fillNow(p);
  return p;
}

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What the ring slider reads out to a screen reader. */
function ringText(text) {
  $("#ring").setAttribute("aria-valuetext", text);
}

function currentSong() {
  return queueSongs[engine.currentIndex] ?? null;
}

function fillNow(p) {
  const song = currentSong();
  const key = song ? `${song.id ?? song.track.id}` : "";
  if (p.dataset.song !== key) {
    p.dataset.song = key;
    const art = song ? coverSvg(song.album, song.artist) : "";
    p.querySelector(".cover").innerHTML = art;
    p.querySelector(".reflect").innerHTML = art;
    p.querySelector(".n").textContent = song
      ? `${engine.currentIndex + 1} of ${queueSongs.length}`
      : "";
    p.querySelector(".ti").textContent = song?.name ?? "Nothing playing";
    p.querySelector(".ar").textContent = song?.artist ?? "";
    p.querySelector(".al").textContent = song?.album ?? "";
  }
  const dur = engine.duration || song?.durationSec || 0;
  const pos = np.scrub ? np.scrubPos : engine.currentTime;
  const f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
  p.querySelector(".fill").style.width = `${f * 100}%`;
  p.querySelector(".diamond").style.left = `${f * 100}%`;
  p.querySelector(".el").textContent = fmt(pos);
  p.querySelector(".rem").textContent = `-${fmt(dur - pos)}`;
  p.classList.toggle("scrub", np.scrub);
  p.classList.toggle("vol-on", performance.now() < np.volUntil);
  p.querySelector(".vfill").style.width = `${engine.volume * 100}%`;
}

function syncPane(text) {
  const p = el("div", "pane");
  p.innerHTML = `<div class="syncing"><div class="spin"></div><div></div><small>Do not disconnect.</small></div>`;
  p.querySelector(".syncing > div:nth-child(2)").textContent = text;
  return p;
}

/** Show the current screen. `dir` 1 slides in from the right, -1 from the left, 0 swaps. */
function show(dir = 0, replacement = null) {
  const next = replacement ?? (nav.screen.now ? nowPane() : listPane());
  const old = pane;
  pane = next;
  panes.append(next);
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (old && dir && motion) {
    const opts = { duration: 240, easing: "cubic-bezier(.3,.7,.2,1)" };
    next.animate(
      [{ transform: `translateX(${dir * 100}%)` }, { transform: "translateX(0)" }],
      opts,
    );
    old
      .animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 100}%)` }], opts)
      .finished.then(
        () => old.remove(),
        () => old.remove(),
      );
  } else {
    old?.remove();
  }
  titleBar();
  announce(describe());
}

function titleBar() {
  const s = nav.screen;
  $("#tbTitle").textContent = local.syncing ? "Sync" : s.title;
  const st = $("#tbState");
  const active = queueSongs.length > 0 && !local.stopped;
  st.className = `state ${active ? (local.paused ? "pause" : "play") : ""}`;
  $("#tbLock").hidden = !local.hold;
}

function describe() {
  const s = nav.screen;
  if (local.syncing) return "Syncing";
  if (s.now) {
    const song = currentSong();
    return song
      ? `Now playing: ${song.name} by ${song.artist}, ${engine.currentIndex + 1} of ${queueSongs.length}`
      : "Now Playing";
  }
  const row = nav.rows()[s.sel];
  return `${s.title}. ${row ? row.label : ""}${row?.detail ? `, ${row.detail}` : ""}`;
}

let announceTimer = 0;
function announce(text) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => ($("#live").textContent = text), 250);
}

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1400);
  announce(text);
}

/* ------------------------------------------------------------------ playback */

/** Leave scrub mode, and drop a seek still waiting for the wheel to rest. */
function endScrub() {
  np.scrub = false;
  clearTimeout(np.scrubTimer);
}

function applySettings() {
  engine.setShuffle(settings.shuffle === 1);
  engine.setRepeat(["none", "one", "all"][settings.repeat]);
}

function startQueue(songs, index) {
  // Safari only starts audio inside the gesture: this runs straight from a press.
  engine.context.resume().catch(() => {});
  queueSongs = songs;
  applySettings();
  engine.setQueue(
    songs.map((s) => s.track),
    index,
  );
  local.stopped = false;
  local.paused = false;
  local.ended = false;
  endScrub();
  engine.play().catch(() => {});
  nav.push(nowPlayingScreen());
  show(1);
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function togglePlay() {
  engine.context.resume().catch(() => {});
  if (!queueSongs.length) {
    if (library.songs.length) startQueue(library.songs, 0);
    else toast("Sync some music first");
    return;
  }
  if (local.stopped) {
    // Only a tape run off the end starts over: a Previous or a scrub since then means the
    // listener chose a place to start from.
    if (local.ended) engine.skipTo(0);
    local.ended = false;
    local.stopped = false;
    local.paused = false;
    engine.play().catch(() => {});
  } else {
    local.paused = !local.paused;
    if (local.paused) engine.pause();
    else engine.play().catch(() => {});
  }
  titleBar();
}

function skip(dir) {
  if (!queueSongs.length) return;
  endScrub();
  local.ended = false;
  if (dir < 0) {
    // Under shuffle, queue position 0 is not the start of the play order: let the engine's
    // history decide where Previous goes.
    if (engine.currentTime > 3 || (engine.currentIndex === 0 && !settings.shuffle)) {
      engine.seek(0);
    } else engine.previous();
  } else if (
    engine.currentIndex < queueSongs.length - 1 ||
    settings.repeat === 2 ||
    settings.shuffle
  ) {
    engine.next();
  }
  if (!local.stopped && !local.paused) engine.play().catch(() => {});
}

engine.on("trackchange", () => {
  if (pane?.classList.contains("np")) fillNow(pane);
  if (nav.screen.now) announce(describe());
});
engine.on("ended", () => {
  local.stopped = true;
  local.paused = false;
  local.ended = true;
  titleBar();
});
engine.on("error", ({ error }) => {
  if (error.code === "prefetch_failed") return;
  // A load that failed outright leaves nothing playing: show it, so Play starts again.
  if (error.code === "autoplay_blocked" || engine.state === "error") {
    local.stopped = true;
    local.paused = false;
  }
  toast(error.code === "autoplay_blocked" ? "Press play" : "Cannot play this song");
  titleBar();
});

/* ------------------------------------------------------------------ the clicker */

let tick = null;
/** The wheel's click: a few milliseconds of filtered noise, made once. */
function click() {
  if (!settings.clicker) return;
  const ctx = engine.context;
  if (!tick) {
    const n = Math.round(ctx.sampleRate * 0.004);
    tick = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = tick.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 5)) * 0.25;
  }
  const src = ctx.createBufferSource();
  src.buffer = tick;
  src.connect(ctx.destination);
  src.start();
}

/* ------------------------------------------------------------------ input */

function wake() {
  $("#lcd").classList.remove("dim");
  clearTimeout(wake.timer);
  wake.timer = setTimeout(() => $("#lcd").classList.add("dim"), 15000);
}

function locked() {
  if (!local.hold) return false;
  toast("Hold switch is on");
  return true;
}

/** Wheel turned by `steps` (clockwise positive). */
function turn(steps) {
  wake();
  if (!steps || locked() || local.syncing) return;
  if (nav.screen.now) {
    if (np.scrub) {
      const dur = engine.duration || 0;
      np.scrubPos = Math.max(0, Math.min(dur, np.scrubPos + steps * Math.max(2, dur / 60)));
      clearTimeout(np.scrubTimer);
      // Seek once the wheel rests, as the real one did, rather than on every step. Only if
      // the same song is still on: a skip in the meantime must not inherit the position.
      const index = engine.currentIndex;
      np.scrubTimer = setTimeout(() => {
        if (engine.currentIndex === index) {
          engine.seek(np.scrubPos);
          local.ended = false;
        }
        np.scrub = false;
      }, 900);
      ringText(`Scrub ${fmt(np.scrubPos)} of ${fmt(dur)}`);
    } else {
      engine.setVolume(Math.max(0, Math.min(1, engine.volume + steps * 0.04)));
      np.volUntil = performance.now() + 1600;
      ringText(`Volume ${Math.round(engine.volume * 100)}%`);
    }
    click();
    fillNow(pane);
    return;
  }
  if (nav.scroll(steps)) {
    click();
    fillList(pane);
    announce(describe());
  }
}

function press(zone) {
  wake();
  // Hold locks everything, the way the switch on the top edge did.
  if (local.syncing || locked()) return;
  litLegend(zone);
  if (zone === "menu") {
    endScrub();
    if (nav.back()) show(-1);
    return;
  }
  if (zone === "play") return togglePlay();
  if (zone === "next") return skip(1);
  if (zone === "prev") return skip(-1);
  if (zone !== "center") return;
  if (nav.screen.now) {
    if (!queueSongs.length) return;
    if (np.scrub) endScrub();
    else np.scrub = true;
    np.scrubPos = engine.currentTime;
    ringText(np.scrub ? `Scrub ${fmt(np.scrubPos)}` : describe());
    fillNow(pane);
    return;
  }
  const action = nav.select();
  if (!action) return;
  click();
  if (action.type === "pushed") show(1);
  else if (action.type === "play") startQueue(action.songs, action.index);
  else if (action.type === "shuffleAll") {
    if (library.songs.length) startQueue(shuffled(library.songs), 0);
    else toast("Sync some music first");
  } else if (action.type === "now") {
    nav.push(nowPlayingScreen());
    show(1);
  } else if (action.type === "setting") {
    settings = cycleSetting(settings, action.key);
    if (queueSongs.length) applySettings();
    fillList(pane);
    announce(describe());
  }
}

function litLegend(zone) {
  const g = document.querySelector(`.legend[data-zone="${zone}"]`);
  if (!g) return;
  g.classList.add("lit");
  setTimeout(() => g.classList.remove("lit"), 160);
}

/* The wheel: one pointer surface. A turn scrolls; a press without a turn hits a quarter. */
const wheel = $("#wheel");
const ring = $("#ring");
const tracker = createTracker();
const touchG = $("#touch");
let gesture = null;

function wheelPoint(e) {
  const r = wheel.getBoundingClientRect();
  const k = 186 / r.width;
  return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
}

function drawTouch(angle, dir) {
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const R = 66;
  const x = 93 + Math.cos(rad(angle)) * R;
  const y = 93 + Math.sin(rad(angle)) * R;
  touchG.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  touchG.setAttribute("opacity", "1");
  const from = angle - dir * 38;
  const fx = 93 + Math.cos(rad(from)) * R;
  const fy = 93 + Math.sin(rad(from)) * R;
  const d = dir
    ? `M${fx.toFixed(1)},${fy.toFixed(1)} A${R},${R} 0 0 ${dir > 0 ? 1 : 0} ${x.toFixed(1)},${y.toFixed(1)}`
    : "";
  $("#trail").setAttribute("d", d);
  $("#trailHi").setAttribute("d", d);
}

function hideTouch() {
  touchG.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: "forwards" });
  for (const id of ["#trail", "#trailHi"]) {
    $(id).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: "forwards" });
  }
  setTimeout(() => {
    touchG.getAnimations().forEach((a) => a.cancel());
    touchG.setAttribute("opacity", "0");
    for (const id of ["#trail", "#trailHi"]) {
      $(id)
        .getAnimations()
        .forEach((a) => a.cancel());
      $(id).setAttribute("d", "");
    }
  }, 400);
}

ring.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  // One finger at a time: a second touch would interleave two angles into one turn.
  if (gesture) return;
  engine.context.resume().catch(() => {});
  ring.setPointerCapture(e.pointerId);
  const p = wheelPoint(e);
  const angle = angleOf(p.x, p.y, 93, 93);
  tracker.start(angle);
  gesture = { angle, start: p, dir: 0, id: e.pointerId, moved: 0 };
  touchG.getAnimations().forEach((a) => a.cancel());
  drawTouch(angle, 0);
});
ring.addEventListener("pointermove", (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  const p = wheelPoint(e);
  gesture.moved = Math.max(gesture.moved, Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y));
  // Over the centre the angle is meaningless: lift the tracker, and let the first point
  // back on the ring only re-seed it, so the jump across is never counted as turn.
  if (!onRing(p.x, p.y, 93, 93)) {
    tracker.end();
    return;
  }
  const angle = angleOf(p.x, p.y, 93, 93);
  const steps = tracker.move(angle);
  if (steps) gesture.dir = Math.sign(steps);
  drawTouch(angle, gesture.dir);
  turn(steps);
});
function endGesture(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  tracker.end();
  hideTouch();
  // A press is a touch that stayed put: little turn, and the finger never wandered (a slide
  // across the centre turns nothing, but it is not a press either).
  if (e.type !== "pointerup" || tracker.travelled > 10 || g.moved > 12) return;
  // A press: which quarter was it?
  const a = angleOf(g.start.x, g.start.y, 93, 93);
  const zone = a >= 315 || a < 45 ? "menu" : a < 135 ? "next" : a < 225 ? "play" : "prev";
  press(zone);
}
ring.addEventListener("pointerup", endGesture);
ring.addEventListener("pointercancel", endGesture);

const center = $("#center");
center.addEventListener("pointerdown", () =>
  $("#centerFace").setAttribute("fill", "url(#ip-btn-down)"),
);
for (const t of ["pointerup", "pointerleave", "pointercancel"]) {
  center.addEventListener(t, () => $("#centerFace").setAttribute("fill", "url(#ip-btn)"));
}
center.addEventListener("click", () => press("center"));
for (const z of document.querySelectorAll(".zone")) {
  z.addEventListener("click", () => press(z.dataset.zone));
}

$("#hold").addEventListener("click", () => {
  local.hold = !local.hold;
  $("#hold").setAttribute("aria-pressed", String(local.hold));
  titleBar();
  announce(local.hold ? "Hold on: controls locked" : "Hold off");
});

const KEYS = {
  arrowup: () => turn(-1),
  arrowdown: () => turn(1),
  arrowleft: () => press("prev"),
  arrowright: () => press("next"),
  enter: () => press("center"),
  escape: () => press("menu"),
  backspace: () => press("menu"),
  " ": () => press("play"),
  h: () => $("#hold").click(),
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // Enter and Space belong to whatever has focus: a button, the Playground link, a field.
  if ((k === " " || k === "enter") && e.target.closest?.("a, button, input, select, textarea")) {
    return;
  }
  const run = KEYS[k];
  if (!run) return;
  e.preventDefault();
  run();
});

document.addEventListener(
  "pointerdown",
  () => document.documentElement.classList.add("pointer"),
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Tab") document.documentElement.classList.remove("pointer");
});

/* ------------------------------------------------------------------ sync */

let syncToken = 0;

/** Replace the library, like a sync does. The demo set goes in the same way. */
async function sync(files) {
  const audio = files.filter(isAudioFile);
  if (!audio.length) {
    toast("No music in that");
    return;
  }
  const token = ++syncToken;
  local.syncing = true;
  show(0, syncPane(`Syncing ${audio.length} song${audio.length === 1 ? "" : "s"}...`));
  const idStart = nextId;
  nextId += audio.length;
  const added = await filesToEntries(audio, idStart);
  if (token !== syncToken) {
    added.forEach((e) => URL.revokeObjectURL(e.url));
    return;
  }
  added.forEach((entry, i) => {
    const path = audio[i].webkitRelativePath || "";
    const parts = path.split("/");
    entry.folder = parts.length > 1 ? parts[parts.length - 2] : "";
  });
  // Empty the engine's queue before the old files go: a skip still loading one of them
  // would otherwise fail with a spurious "cannot play".
  if (queueSongs.length) engine.setQueue([]);
  endScrub();
  queueSongs = [];
  local.ended = false;
  local.stopped = true;
  local.paused = false;
  const old = entries;
  entries = added;
  library = buildLibrary(entries);
  old.forEach((e) => URL.revokeObjectURL(e.url));
  local.syncing = false;
  while (nav.back());
  show(0);
}

const picker = Object.assign(document.createElement("input"), {
  type: "file",
  multiple: true,
  accept: "audio/*",
  hidden: true,
});
document.body.append(picker);
picker.addEventListener("change", () => {
  sync([...picker.files]);
  picker.value = "";
});
$("#sync").addEventListener("click", () => {
  engine.context.resume().catch(() => {});
  picker.click();
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
  sync([...e.dataTransfer.files]);
});

addEventListener("pagehide", (e) => {
  if (!e.persisted) entries.forEach((entry) => URL.revokeObjectURL(entry.url));
});

/* ------------------------------------------------------------------ fit and run */

function fit() {
  const narrow = innerWidth < 640;
  const byWidth = narrow ? (innerWidth - 24) / 330 : (innerWidth - 32) / 600;
  const s = Math.max(0.5, Math.min(1.6, byWidth, (innerHeight - 200) / 640));
  document.documentElement.style.setProperty("--s", s.toFixed(3));
}
addEventListener("resize", fit);
fit();

function frame() {
  if (pane?.classList.contains("np")) fillNow(pane);
  requestAnimationFrame(frame);
}

show(0);
wake();
requestAnimationFrame(frame);
document.documentElement.dataset.ready = "1";

// Out of the box the player holds the generated Ember Set, synced like any other music. It
// takes a moment to render, so it happens after the first paint, behind the sync screen.
local.syncing = true;
show(0, syncPane("Syncing the Ember Set..."));
setTimeout(() => {
  // A drop or Sync in the first moments wins: never overwrite it with the demo.
  if (syncToken !== 0) return;
  local.syncing = false;
  sync(setFiles());
}, 120);

/** For poking from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ engine, nav, library, settings, queueSongs, local });
