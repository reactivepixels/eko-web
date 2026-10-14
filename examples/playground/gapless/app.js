/**
 * GT-1 Gapless Blind Test. Each round: the same track change played by two plain <audio>
 * tags and by the engine, behind keys A and B in a random order. Both are recorded as they
 * play, so the reveal shows the real seams, measured to the sample.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { isAudioFile, titleFromName } from "../shared/files.js";
import { createCapture } from "./audio/capture.js";
import { CLIP_RATE, HALF, renderRound, ROUNDS, splitAt } from "./audio/clips.js";
import { createEkoPlayer, createTagPlayer } from "./audio/players.js";
import { contentStart, findGap, measureSeam, SEARCH } from "./audio/seam.js";
import {
  advance,
  canGuess,
  correctCount,
  createGame,
  finished,
  guess,
  hear,
  playedCount,
  revealed,
  ROUND_COUNT,
  verdict,
} from "./game.js";
import { drawScreen, H, W } from "./ui/display.js";

const $ = (sel) => document.querySelector(sel);

// Normalization off: the engine would otherwise level the two halves, and EKO would give
// itself away by sounding different rather than by joining them better.
const engine = new EkoWebEngine({ normalize: false, transition: "gapless" });
if (navigator.audioSession) navigator.audioSession.type = "playback";

let game = createGame();
/** Round sources: the built-in ten, or pairs of tracks from an album you dropped in. */
let source = { kind: "builtin", files: [] };
const built = new Map();

const view = {
  playing: null,
  captures: { A: null, B: null },
  seams: { A: null, B: null },
  chosen: null,
  clipped: false,
};

/* ------------------------------------------------------------------ audio */

let audio = null;
let audioReady = null;
let players = null;

/**
 * The two players, built synchronously so the tag's elements can be unlocked inside the
 * gesture. Only the player under test is wired to the capture, and only while it plays:
 * the other one's fade-out must never end up in the recording.
 */
function ensurePlayers() {
  if (players) return players;
  const ctx = engine.context;
  const tagOut = ctx.createGain();
  tagOut.connect(ctx.destination);
  players = {
    ctx,
    tag: createTagPlayer(ctx, tagOut),
    eko: createEkoPlayer(engine),
    taps: { tag: tagOut, eko: engine.analyser },
  };
  $('[data-led="rate"] span').textContent = `${Math.round(ctx.sampleRate / 100) / 10}K`;
  return players;
}

/** Players plus the capture point. A failed setup is not cached: the next press retries. */
function ensureAudio() {
  audioReady ??= (async () => {
    const p = ensurePlayers();
    const capture = await createCapture(p.ctx);
    audio = { ...p, capture };
    return audio;
  })().catch((err) => {
    audioReady = null;
    throw err;
  });
  return audioReady;
}

let wired = null;
function wire(tap) {
  unwire();
  tap.connect(audio.capture.input);
  wired = tap;
}
function unwire() {
  if (!wired) return;
  try {
    wired.disconnect(audio.capture.input);
  } catch {
    // Already gone.
  }
  wired = null;
}

/* ------------------------------------------------------------------ rounds */

const splitTitle = (t) => {
  const m = /^(\d+)\s+(.*)$/.exec(t);
  return m ? [m[1], m[2]] : ["", t];
};

/** Rounds in progress, so two presses never build (or decode) the same round twice. */
const pending = new Map();
/** Bumped when the source changes: a round finished for an old album is thrown away. */
let generation = 0;

/** One round's two files, plus the music as written for the screen before the reveal. */
function buildRound(index) {
  if (!pending.has(index)) {
    const gen = generation;
    const p = makeRound(index).then((round) => {
      if (gen !== generation) {
        round.urls.forEach((u) => URL.revokeObjectURL(u));
        throw new Error("stale");
      }
      // Silence the music itself has at the seam, so only the player's is counted.
      const mid = Math.round(round.half * round.rate);
      const reach = Math.round(SEARCH * round.rate);
      round.sourceGapSec = findGap(round.source, mid - reach, mid + reach).length / round.rate;
      round.leadIn = Math.max(0, contentStart(round.source)) / round.rate;
      built.set(index, round);
      return round;
    });
    p.catch(() => pending.delete(index));
    pending.set(index, p);
  }
  return pending.get(index);
}

async function makeRound(index) {
  let round;
  if (source.kind === "builtin") {
    const meta = ROUNDS[index % ROUNDS.length];
    const samples = renderRound(index);
    const [a, b] = splitAt([samples], CLIP_RATE, CLIP_RATE * HALF);
    const [fromNo, from] = splitTitle(meta.from);
    const [toNo, to] = splitTitle(meta.to);
    round = {
      from,
      to,
      fromNo,
      toNo,
      side: meta.side,
      half: HALF,
      rate: CLIP_RATE,
      source: samples,
      urls: [URL.createObjectURL(a), URL.createObjectURL(b)],
      seamClock: "0:03.000",
    };
  } else {
    round = await albumRound(index);
  }
  return round;
}

/**
 * A real track change from your files: the last few seconds of one track and the first few
 * of the next, decoded and written back out as lossless WAV, so neither player is fighting
 * encoder padding. The bare tag gets its best case.
 */
async function albumRound(index) {
  const { ctx } = await ensureAudio();
  const [fa, fb] = [source.files[index], source.files[index + 1]];
  const [a, b] = await Promise.all(
    [fa, fb].map(async (f) => ctx.decodeAudioData(await f.arrayBuffer())),
  );
  const half = Math.min(4, a.duration / 2, b.duration / 2);
  const tail = Math.round(half * a.sampleRate);
  const head = Math.round(half * b.sampleRate);
  const chCount = Math.min(2, a.numberOfChannels, b.numberOfChannels);
  const channels = [];
  for (let c = 0; c < chCount; c++) {
    const joined = new Float32Array(tail + head);
    joined.set(a.getChannelData(c).subarray(a.length - tail), 0);
    joined.set(b.getChannelData(c).subarray(0, head), tail);
    channels.push(joined);
  }
  const mono = new Float32Array(tail + head);
  for (const ch of channels)
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
  const [wa, wb] = splitAt(channels, a.sampleRate, tail);
  const end = a.duration;
  const clock = `${Math.floor(end / 60)}:${(end % 60).toFixed(3).padStart(6, "0")}`;
  return {
    from: titleFromName(fa.name),
    to: titleFromName(fb.name),
    fromNo: String(index + 1).padStart(2, "0"),
    toNo: String(index + 2).padStart(2, "0"),
    side: "Your album",
    half,
    rate: a.sampleRate,
    source: mono,
    urls: [URL.createObjectURL(wa), URL.createObjectURL(wb)],
    seamClock: clock,
  };
}

function dropRounds() {
  generation += 1;
  for (const r of built.values()) r.urls.forEach((u) => URL.revokeObjectURL(u));
  built.clear();
  pending.clear();
}

/* ------------------------------------------------------------------ play, guess, next */

let playToken = 0;

let auditionTimer = 0;

function stopPlaying() {
  playToken += 1;
  clearTimeout(auditionTimer);
  if (!audio || !view.playing) return;
  audio.tag.stop();
  audio.eko.stop();
  unwire();
  audio.capture.stop();
  view.playing = null;
  render();
}

async function play(side) {
  // Safari only starts audio inside the gesture: wake the context, and let the tag's
  // elements play once, before any await.
  engine.context.resume().catch(() => {});
  const ready = built.get(game.index);
  ensurePlayers().tag.unlock(ready?.urls);
  if (view.playing === side) return stopPlaying();
  stopPlaying();
  const mine = playToken;
  const index = game.index;
  let a;
  let r;
  try {
    a = await ensureAudio();
    r = await buildRound(index);
  } catch (err) {
    if (mine !== playToken || err?.message === "stale") return;
    say(
      err?.name === "RangeError"
        ? "Those tracks are too long to decode here. Try shorter ones."
        : `The test could not start in this browser (${err?.name || "error"}).`,
    );
    return;
  }
  if (mine !== playToken) return;
  view.playing = side;
  render();
  const who = game.eko[index] === side ? "eko" : "tag";
  const fail = (err) => {
    if (mine !== playToken) return;
    stopPlaying();
    say(`That one would not play (${err?.code || err?.name || err?.message || "error"}).`);
  };
  wire(a.taps[who]);
  a.capture.start();
  // Never record forever: a stuck player is a failed audition.
  auditionTimer = setTimeout(() => fail(new Error("timed out")), (r.half * 2 + 8) * 1000);
  say(`Playing ${side}. Listen for the moment ${r.from} becomes ${r.to}.`);
  await a[who].play(
    r.urls,
    async () => {
      if (mine !== playToken) return;
      clearTimeout(auditionTimer);
      // A little extra, so a late tail is in the recording too.
      await new Promise((res) => setTimeout(res, 120));
      if (mine !== playToken) return;
      unwire();
      const samples = await a.capture.stop();
      if (mine !== playToken) return;
      const rate = a.ctx.sampleRate;
      view.captures[side] = samples;
      view.seams[side] = measureSeam(
        samples,
        rate,
        r.half,
        Math.round(r.sourceGapSec * rate),
        r.leadIn,
      );
      view.clipped ||= samples.some((v) => Math.abs(v) >= 0.999);
      view.playing = null;
      hear(game, side);
      say(
        canGuess(game) ? "Heard both. Which one was EKO?" : `Now play ${side === "A" ? "B" : "A"}.`,
      );
      render();
    },
    fail,
  );
}

const describeSeam = (m) =>
  !m || !m.valid
    ? "could not be measured"
    : m.samples > 0
      ? `left ${m.ms.toFixed(1)} ms of silence`
      : "joined with no gap";

function makeGuess(side) {
  if (revealed(game)) return;
  if (!canGuess(game)) {
    say("Play both A and B all the way through first. Then guess.");
    return;
  }
  stopPlaying();
  const right = guess(game, side);
  view.chosen = side;
  saveBest();
  const eko = game.eko[game.index];
  const tagS = eko === "A" ? "B" : "A";
  say(
    `${right ? "Right" : "Not this time"}: ${eko} was EKO and ${describeSeam(view.seams[eko])}. ` +
      `${tagS}, the bare tag, ${describeSeam(view.seams[tagS])}. ` +
      `Score ${correctCount(game)} of ${playedCount(game)}.`,
  );
  if (finished(game)) {
    const c = correctCount(game);
    sayTimer = setTimeout(() => say(`${c} out of ${game.count}. ${verdict(c, game.count)}`), 2600);
  }
  render();
}

function next() {
  if (!revealed(game)) return;
  stopPlaying();
  if (finished(game)) {
    game = createGame(game.count);
    say("New game, new order. Play A and B.");
  } else {
    advance(game);
    say("Next round. Play A and B.");
  }
  view.captures = { A: null, B: null };
  view.seams = { A: null, B: null };
  view.chosen = null;
  prepare();
  render();
}

/** Build the built-in round ahead of time: it needs no AudioContext, and the screen wants it. */
function prepare() {
  if (source.kind === "builtin") buildRound(game.index);
}

/* ------------------------------------------------------------------ your own album */

const picker = Object.assign(document.createElement("input"), {
  type: "file",
  multiple: true,
  accept: "audio/*",
  hidden: true,
});
document.body.append(picker);
picker.addEventListener("change", () => {
  useAlbum([...picker.files]);
  picker.value = "";
});
$("#choose").addEventListener("click", () => {
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
  useAlbum([...e.dataTransfer.files]);
});

function useAlbum(files) {
  const tracks = files
    .filter(isAudioFile)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (tracks.length < 2) {
    say("Drop at least two consecutive tracks: the test needs a track change.");
    return;
  }
  stopPlaying();
  dropRounds();
  source = { kind: "album", files: tracks };
  game = createGame(Math.min(ROUND_COUNT, tracks.length - 1));
  view.captures = { A: null, B: null };
  view.seams = { A: null, B: null };
  view.chosen = null;
  say(`${game.count} track changes from your album, in order. Play A and B.`);
  ensureAudio()
    .then(() => buildRound(0))
    .then(render)
    .catch((err) => {
      if (err?.message === "stale") return;
      say(
        err?.name === "RangeError"
          ? "Those tracks are too long to decode here. Try shorter ones."
          : "Those files would not decode in this browser.",
      );
    });
  render();
}

/* ------------------------------------------------------------------ status and score */

let sayTimer = 0;
function say(text) {
  clearTimeout(sayTimer);
  $("#status").textContent = text;
}

const BEST_KEY = "eko-gt1:best";
function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
let best = loadBest();
function saveBest() {
  best = Math.max(best, game.bestStreak);
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // Private mode: the best streak just lasts for this visit.
  }
}

const two = (n) => String(n).padStart(2, "0");

function render() {
  for (const key of document.querySelectorAll("[data-play]")) {
    const on = view.playing === key.dataset.play;
    key.classList.toggle("on", on);
    key.classList.toggle("down", on);
    key.setAttribute("aria-pressed", String(on));
  }
  const open = canGuess(game);
  for (const key of document.querySelectorAll("[data-guess]")) {
    const chosen = view.chosen === key.dataset.guess;
    key.classList.toggle("orange", chosen);
    key.classList.toggle("down", chosen);
    key.classList.toggle("on", chosen);
    key.setAttribute("aria-disabled", String(!open));
  }
  $('[data-led="play"]').classList.toggle("on", Boolean(view.playing));
  $('[data-led="clip"]').classList.toggle("on", view.clipped);

  $("#score").innerHTML = `${two(correctCount(game))}<span>/</span>${two(playedCount(game))}`;
  $("#streak").textContent = two(game.streak);
  $("#best").textContent = `▲ Best ${two(Math.max(best, game.bestStreak))}`;
  $("#pips").innerHTML = game.results
    .map(
      (r, i) =>
        `<i class="${r === true ? "w" : r === false ? "x" : i === game.index ? "n" : ""}"></i>`,
    )
    .join("");

  const nextBtn = $("#next");
  nextBtn.hidden = !revealed(game);
  nextBtn.textContent = finished(game) ? "New game ›" : "Next ›";
}

/* ------------------------------------------------------------------ the screen */

const canvas = $("#screen");
const ctx2d = canvas.getContext("2d");
let scale = 1;

function sizeCanvas() {
  const k = scale * Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(W * k);
  canvas.height = Math.round(H * k);
  ctx2d.setTransform(k, 0, 0, k, 0, 0);
}

function screenState() {
  const r = built.get(game.index);
  const isRevealed = revealed(game);
  const lanes = {};
  for (const side of ["A", "B"]) {
    if (isRevealed && view.captures[side] && view.seams[side].valid) {
      lanes[side] = {
        samples: view.captures[side],
        at: view.seams[side].at,
        rate: audio.ctx.sampleRate,
        seam: view.seams[side],
      };
    } else {
      lanes[side] = {
        samples: r?.source ?? new Float32Array(0),
        at: r ? Math.round(r.half * r.rate) : 0,
        rate: r?.rate ?? CLIP_RATE,
        // Revealed but not measurable: say so rather than draw a clean seam.
        seam: { samples: 0, valid: !(isRevealed && view.captures[side]) },
      };
    }
  }
  let playhead = null;
  if (view.playing && audio && r) {
    const player = game.eko[game.index] === view.playing ? audio.eko : audio.tag;
    playhead = 62 + 356 / 2 + (player.position(r.half) - r.half) * 356;
  }
  const meta = r ?? (source.kind === "builtin" ? builtinMeta(game.index) : null);
  const right = isRevealed ? game.results[game.index] : null;
  return {
    round: game.index,
    count: game.count,
    from: meta?.from ?? "",
    to: meta?.to ?? "",
    fromNo: meta?.fromNo ?? "",
    toNo: meta?.toNo ?? "",
    side: meta?.side ?? "",
    seamClock: meta?.seamClock ?? "",
    rate: audio?.ctx.sampleRate ?? CLIP_RATE,
    revealed: isRevealed,
    eko: game.eko[game.index],
    heard: game.heard,
    lanes,
    playing: view.playing,
    playhead,
    status: view.playing
      ? `PLAYING ${view.playing}`
      : isRevealed
        ? right
          ? "CORRECT · REVEALED"
          : "MISSED · REVEALED"
        : canGuess(game)
          ? "MAKE YOUR GUESS"
          : "LISTEN TO BOTH",
    hint: canGuess(game) ? "WHICH ONE WAS EKO?" : "PLAY A AND B, THEN GUESS",
  };
}

function builtinMeta(index) {
  const meta = ROUNDS[index % ROUNDS.length];
  const [fromNo, from] = splitTitle(meta.from);
  const [toNo, to] = splitTitle(meta.to);
  return { from, to, fromNo, toNo, side: meta.side, seamClock: "0:03.000" };
}

function frame() {
  drawScreen(ctx2d, screenState());
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ input */

for (const key of document.querySelectorAll("[data-play]")) {
  key.addEventListener("click", () => play(key.dataset.play));
}
for (const key of document.querySelectorAll("[data-guess]")) {
  key.addEventListener("click", () => makeGuess(key.dataset.guess));
}
$("#next").addEventListener("click", next);

const KEYS = {
  1: () => play("A"),
  2: () => play("B"),
  a: () => makeGuess("A"),
  b: () => makeGuess("B"),
  enter: next,
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((k === "enter" || k === " ") && e.target instanceof HTMLButtonElement) return;
  if (e.repeat) return;
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

/* ------------------------------------------------------------------ fit */

function fit() {
  const s = Math.max(0.4, Math.min(1.8, (innerWidth - 32) / 704, (innerHeight - 140) / 540));
  scale = s;
  document.documentElement.style.setProperty("--s", s.toFixed(3));
  sizeCanvas();
}
addEventListener("resize", fit);
fit();

addEventListener("pagehide", (e) => {
  if (!e.persisted) dropRounds();
});

prepare();
render();
document.fonts?.ready.then(() => document.documentElement.classList.add("fonts"));
document.documentElement.dataset.ready = "1";
requestAnimationFrame(frame);

/** For poking from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ engine, game, view, audio, built });
