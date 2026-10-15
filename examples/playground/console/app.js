/**
 * EKO NB-124, the Night Bus console. A drum machine and an eight-channel desk sharing one
 * AudioContext and one clock:
 *
 * - Channels 1 to 4 are the rhythm composer's voices, synthesized and scheduled ahead on
 *   the context clock from the step pattern.
 * - Channels 5 to 8 are the Night Bus stems, rendered as eight-bar loops at the console's
 *   tempo and played by four EKO engines. Each engine's `destination` is its channel strip,
 *   each loops on repeat-one with gapless joins, and all four start with `play({ at })`
 *   on the same sample as the drum machine's downbeat.
 *
 * A tempo change lands on the next eight-bar phrase: a fresh set of engines, rendered at
 * the new tempo, starts there while the old set stops, and the sequencer changes speed on
 * the same sample.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { createNeedle, rmsDb, stepNeedle } from "../hifi/audio/meters.js";
import { slider, toggle } from "../hifi/ui/controls.js";
import {
  bassHz,
  clonePattern,
  nextPhrase,
  PATTERNS,
  pressStep,
  stepSeconds,
  stepTime,
  STEPS,
  VOICES,
} from "./audio/sequencer.js";
import { STEMS, stemUrls } from "./audio/stems.js";
import {
  audibility,
  createEcho,
  createMaster,
  createStrip,
  ECHO,
  faderDb,
  STRIP,
} from "./audio/strip.js";
import { BASS, createVoices, KIT } from "./audio/voices.js";
import { buildPanel, CHANNELS, sevenSeg, VU } from "./ui/panel.js";

const $ = (sel) => document.querySelector(sel);
const parts = buildPanel($("#face"));

/* ------------------------------------------------------------------ the model */

const DEFAULT_MIX = [
  { fader: 0.72, pan: 0 },
  { fader: 0.62, pan: 0.15, echo: 0.35 },
  { fader: 0.6, pan: -0.25 },
  { fader: 0.7, pan: 0 },
  { fader: 0.62, pan: 0.35, echo: 0.3 },
  { fader: 0.55, pan: -0.3 },
  { fader: 0.5, pan: 0 },
  { fader: 0.45, pan: 0.2 },
];

const model = {
  bpm: 124,
  /** A tempo set on the knob, waiting for the next phrase. */
  pendingBpm: null,
  swing: 0,
  pattern: "A",
  queuedPattern: null,
  patterns: Object.fromEntries(Object.entries(PATTERNS).map(([k, p]) => [k, clonePattern(p)])),
  kit: { ...KIT },
  bass: { ...BASS },
  strips: DEFAULT_MIX.map((m) => ({ ...STRIP, ...m })),
  echo: { ...ECHO },
  master: 0.66,
};

/* ------------------------------------------------------------------ audio */

let audio = null;

/** Everything audio lives in one context, made on the first START (a user gesture). */
function ensureAudio() {
  if (audio) return audio;
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const master = createMaster(ctx);
  const echo = createEcho(ctx, master.bus);
  const strips = CHANNELS.map(() => createStrip(ctx, master.bus, echo.input));
  audio = { ctx, master, echo, strips, voices: createVoices(ctx), stems: null };
  applyMix();
  return audio;
}

function applyMix() {
  if (!audio) return;
  const heard = audibility(model.strips);
  audio.strips.forEach((s, i) => s.set(model.strips[i], heard[i]));
  audio.echo.set(model.echo, 60 / model.bpm);
  audio.master.set(model.master);
}

/**
 * A set of four stem engines at one tempo, loaded and waiting. Each engine plays into its
 * own gain stage and on into its channel strip, and loops its stem gaplessly. The gain
 * stage is the set's: it lets one set fade out on the exact sample the next one starts.
 */
async function loadStems(bpm) {
  const { ctx, strips } = audio;
  const urls = stemUrls(bpm);
  const gains = STEMS.map((_, i) => {
    const g = ctx.createGain();
    g.connect(strips[4 + i].input);
    return g;
  });
  const engines = STEMS.map(
    (_, i) =>
      new EkoWebEngine({
        context: ctx,
        destination: gains[i],
        normalize: false,
        transition: "gapless",
        source: "buffer",
      }),
  );
  const set = { bpm, engines, urls, gains };
  try {
    await Promise.all(
      engines.map(
        (engine, i) =>
          new Promise((resolve, reject) => {
            const offReady = engine.on("canplay", () => {
              offReady();
              offError();
              resolve();
            });
            const offError = engine.on("error", ({ error }) => {
              offReady();
              offError();
              reject(error);
            });
            engine.setRepeat("one");
            engine.setQueue([{ id: `${STEMS[i].id}-${bpm}`, src: urls[i] }]);
          }),
      ),
    );
  } catch (err) {
    dropStems(set);
    throw err;
  }
  return set;
}

function dropStems(set) {
  if (!set) return;
  for (const e of set.engines) e.destroy();
  for (const g of set.gains) g.disconnect();
  set.urls.forEach((u) => URL.revokeObjectURL(u));
}

/** Silence a set from `at`: a 5 ms fade ending exactly on the sample the next set starts. */
function fadeOutAt(set, at) {
  for (const g of set.gains) {
    g.gain.cancelScheduledValues(0);
    g.gain.setValueAtTime(1, Math.max(audio.ctx.currentTime, at - 0.005));
    g.gain.linearRampToValueAtTime(0, at);
  }
}
function restoreLevel(set) {
  for (const g of set.gains) {
    g.gain.cancelScheduledValues(0);
    g.gain.value = 1;
  }
}

/* ------------------------------------------------------------------ the clock */

const clock = {
  running: false,
  origin: 0,
  /** The next step to schedule, counted from `origin`. */
  nextIndex: 0,
  /** A tempo change booked for a phrase boundary: { at, bpm, set }. */
  change: null,
  timer: 0,
  /** Steps scheduled but not yet sounded, for the step cursor. */
  ahead: [],
};

const LOOKAHEAD = 0.12;

function scheduleStep(step, time) {
  const p = model.patterns[model.pattern];
  const { voices, strips } = audio;
  const d = stepSeconds(model.bpm);
  if (p.bd[step]) voices.kick(time, strips[0].input, model.kit);
  if (p.cp[step]) voices.clap(time, strips[1].input);
  if (p.ch[step]) voices.hat(time, strips[2].input, false, model.kit);
  if (p.oh[step]) voices.hat(time, strips[2].input, true, model.kit);
  const note = p.bl[step];
  if (note) {
    let len = 1;
    while (len < 4 && !p.bl[(step + len) % STEPS]) len++;
    voices.bass(time, bassHz(note), len * d * 0.92, strips[3].input, model.bass);
  }
  clock.ahead.push({ step, time });
}

/**
 * Schedule every step due before the lookahead. Steps are counted, not timed, so moving
 * the swing knob can never schedule a step twice or skip one. A step whose time has
 * already passed (a background tab throttles timers to a second or more) is dropped
 * rather than played late in a pile.
 */
function tick() {
  const now = audio.ctx.currentTime;
  const until = now + LOOKAHEAD;
  for (;;) {
    const end = clock.change ? Math.min(until, clock.change.at) : until;
    for (;;) {
      const t = stepTime(clock.origin, clock.nextIndex, model.bpm, model.swing);
      if (t >= end) break;
      const step = clock.nextIndex % STEPS;
      // A queued pattern starts on the downbeat of the next bar.
      if (step === 0 && model.queuedPattern) {
        model.pattern = model.queuedPattern;
        model.queuedPattern = null;
        renderPatternButtons();
        renderPads();
        say(`Pattern ${model.pattern}.`);
      }
      if (t >= now - 0.02) scheduleStep(step, t);
      clock.nextIndex += 1;
    }
    if (!clock.change || end < clock.change.at) break;
    // The phrase boundary: the booked set takes over on this sample, drums and stems both.
    const { at, bpm, set } = clock.change;
    const old = audio.stems;
    audio.stems = set;
    clock.origin = at;
    clock.nextIndex = 0;
    clock.change = null;
    model.bpm = bpm;
    if (model.pendingBpm === bpm) model.pendingBpm = null;
    setTimeout(() => dropStems(old), Math.max(0, (at - now) * 1000 + 60));
    applyMix();
    renderDisplay();
  }
}

/** Throw away a booked tempo change that has not happened yet. */
function cancelChange() {
  const c = clock.change;
  if (!c) return;
  clock.change = null;
  restoreLevel(audio.stems);
  dropStems(c.set);
}

let busy = false;
let startCancelled = false;

async function start() {
  const a = ensureAudio();
  // Safari only starts audio inside the gesture: before any await.
  a.ctx.resume().catch(() => {});
  if (clock.running || busy) return;
  busy = true;
  startCancelled = false;
  renderDisplay();
  try {
    if (model.pendingBpm) {
      model.bpm = model.pendingBpm;
      model.pendingBpm = null;
    }
    if (!a.stems || a.stems.bpm !== model.bpm) {
      say("Rendering the Night Bus stems at " + model.bpm + " bpm.");
      await new Promise(requestAnimationFrame);
      const old = a.stems;
      a.stems = await loadStems(model.bpm);
      dropStems(old);
    }
    if (startCancelled) return;
    const t0 = a.ctx.currentTime + 0.12;
    clock.origin = t0;
    clock.nextIndex = 0;
    clock.change = null;
    clock.ahead = [];
    restoreLevel(a.stems);
    for (const e of a.stems.engines) {
      e.seek(0);
      e.play({ at: t0 });
    }
    clock.running = true;
    clock.timer = setInterval(tick, 25);
    tick();
    say("Running. Four stems on EKO engines, locked to the drum machine's downbeat.");
  } catch (err) {
    say(`The console could not start (${err?.code || err?.name || "error"}).`);
  } finally {
    busy = false;
    renderTransport();
    renderDisplay();
  }
}

function stop() {
  // STOP during the first render cancels the start it is waiting on.
  if (busy && !clock.running) startCancelled = true;
  clearTimeout(tempoTimer);
  if (!clock.running) return;
  clearInterval(clock.timer);
  clock.running = false;
  cancelChange();
  clock.ahead = [];
  for (const e of audio.stems?.engines ?? []) e.pause();
  if (model.pendingBpm) {
    model.bpm = model.pendingBpm;
    model.pendingBpm = null;
  }
  applyMix();
  renderTransport();
  renderDisplay();
  say("");
}

/** Ask for a tempo: it takes effect on the next phrase, stems and drums together. */
let tempoTimer = 0;
function requestTempo(bpm) {
  clearTimeout(tempoTimer);
  if (bpm === model.bpm) {
    // Back where it is: cancel anything booked, so what you hear matches the knob.
    model.pendingBpm = null;
    if (clock.running) cancelChange();
    renderDisplay();
    return;
  }
  model.pendingBpm = bpm;
  renderDisplay();
  if (clock.running) tempoTimer = setTimeout(() => changeTempo(bpm), 600);
}

async function changeTempo(bpm) {
  if (!clock.running || !bpm) return;
  if (busy) {
    // A render is already running: it will pick up the newest request when it finishes.
    return;
  }
  busy = true;
  const a = audio;
  try {
    await new Promise(requestAnimationFrame);
    const next = await loadStems(bpm);
    if (!clock.running || model.pendingBpm !== bpm) {
      dropStems(next);
      return;
    }
    // A change booked earlier and not yet reached never sounds: replace it outright.
    cancelChange();
    const at = nextPhrase(clock.origin, a.ctx.currentTime, model.bpm, 0.4);
    clock.change = { at, bpm, set: next };
    for (const e of next.engines) e.play({ at });
    fadeOutAt(a.stems, at);
    say(`Tempo ${bpm} from the next phrase.`);
  } catch (err) {
    say(`Could not re-render at ${bpm} bpm (${err?.code || err?.name}).`);
  } finally {
    busy = false;
    // The knob moved again while this rendered: go after the newest request.
    const want = model.pendingBpm;
    if (clock.running && want && want !== bpm && want !== model.bpm) changeTempo(want);
  }
}

/* ------------------------------------------------------------------ the panel */

let sayTimer = 0;
function say(text) {
  $("#status").textContent = text;
  clearTimeout(sayTimer);
  if (text) sayTimer = setTimeout(() => ($("#status").textContent = ""), 5000);
}

function knobControl(el, o) {
  const span = Number(el.dataset.span || 135);
  return slider(el, {
    ...o,
    render: (v) => {
      el.style.setProperty("--a", `${-span + ((v - o.min) / (o.max - o.min)) * 2 * span}deg`);
      o.after?.(v);
    },
  });
}

function faderControl(el, o) {
  const cap = el.querySelector(".fcap");
  const h = parseFloat(el.style.height) - 46;
  return slider(el, {
    min: 0,
    max: 1,
    step: 0.005,
    bigStep: 0.05,
    vertical: true,
    track: el.querySelector(".ftrack"),
    format: (v) => {
      const db = faderDb(v);
      return db === -Infinity ? "off" : `${db.toFixed(1)} dB`;
    },
    ...o,
    render: (v) => (cap.style.top = `${23 + (1 - v) * h}px`),
  });
}

const pct = (v) => `${Math.round(v * 100)}%`;
const db = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const change = (fn) => (v) => {
  fn(v);
  applyMix();
};

function wire() {
  knobControl(parts.knobs.tempo, {
    label: "Tempo",
    min: 90,
    max: 150,
    step: 1,
    bigStep: 5,
    value: model.bpm,
    travel: 300,
    format: (v) => `${v} bpm`,
    onInput: (v) => requestTempo(v),
  });
  knobControl(parts.knobs.swing, {
    label: "Swing",
    min: 0,
    max: 0.6,
    step: 0.01,
    value: model.swing,
    format: pct,
    onInput: (v) => (model.swing = v),
  });
  const synth = (id, key, label) =>
    knobControl(parts.knobs[id], {
      label,
      min: 0,
      max: 1,
      step: 0.01,
      value: model.bass[key] ?? model.kit[key],
      format: pct,
      onInput: (v) => {
        if (key in model.bass) model.bass[key] = v;
        else model.kit[key] = v;
      },
    });
  synth("cutoff", "cutoff", "Bass cutoff");
  synth("reso", "reso", "Bass resonance");
  synth("decay", "decay", "Bass decay");
  synth("bdDecay", "bdDecay", "Bass drum decay");
  synth("hatDecay", "hatDecay", "Hat decay");
  knobControl(parts.knobs.bdTune, {
    label: "Bass drum tune",
    min: -12,
    max: 12,
    step: 1,
    value: model.kit.bdTune,
    detent: 0,
    format: (v) => `${v > 0 ? "+" : ""}${v} semitones`,
    onInput: (v) => (model.kit.bdTune = v),
  });

  parts.strips.forEach((ui, i) => {
    const s = model.strips[i];
    const name = CHANNELS[i].name;
    const eq = (key, label) =>
      knobControl(ui[key], {
        label: `${name} ${label}`,
        min: -15,
        max: 15,
        step: 0.5,
        value: s[key],
        detent: 0,
        format: db,
        onInput: change((v) => (s[key] = v)),
      });
    knobControl(ui.trim, {
      label: `${name} trim`,
      min: -20,
      max: 20,
      step: 0.5,
      value: s.trim,
      detent: 0,
      format: db,
      onInput: change((v) => (s.trim = v)),
    });
    eq("hi", "high EQ");
    eq("mid", "mid EQ");
    eq("lo", "low EQ");
    knobControl(ui.echo, {
      label: `${name} echo send`,
      min: 0,
      max: 1,
      step: 0.01,
      value: s.echo,
      format: pct,
      onInput: change((v) => (s.echo = v)),
    });
    knobControl(ui.pan, {
      label: `${name} pan`,
      min: -1,
      max: 1,
      step: 0.05,
      value: s.pan,
      detent: 0,
      format: (v) => (v === 0 ? "centre" : `${pct(Math.abs(v))} ${v < 0 ? "left" : "right"}`),
      onInput: change((v) => (s.pan = v)),
    });
    faderControl(ui.fader, {
      label: `${name} fader`,
      value: s.fader,
      onInput: change((v) => (s.fader = v)),
    });
    const lamp = (btn, key, color) =>
      toggle(btn, {
        label: `${key === "mute" ? "Mute" : "Solo"} ${name}`,
        value: s[key],
        render: (on) => {
          btn.classList.toggle("lit", on);
          btn.style.setProperty("--cap", on ? color : "#bdb7aa");
        },
        onChange: change((on) => (s[key] = on)),
      });
    lamp(ui.mute, "mute", "#ff4a2a");
    lamp(ui.solo, "solo", "#f0c94a");
  });

  const echoKnob = (id, key, label) =>
    knobControl(parts.knobs[id], {
      label,
      min: 0,
      max: 1,
      step: 0.01,
      value: model.echo[key],
      format: pct,
      onInput: change((v) => (model.echo[key] = v)),
    });
  echoKnob("echoTime", "time", "Echo time");
  echoKnob("echoRepeat", "repeat", "Echo repeat");
  echoKnob("echoTone", "tone", "Echo tone");
  echoKnob("echoReturn", "ret", "Echo return");
  toggle(parts.sync, {
    label: "Sync echo to tempo",
    value: model.echo.sync,
    render: (on) => {
      parts.sync.classList.toggle("lit", on);
      parts.sync.style.setProperty("--cap", on ? "#ef6a1e" : "#bdb7aa");
      parts.syncNote.textContent = on
        ? "Echo locks to tempo · 1/8 dotted"
        : "Free time · set by Time";
    },
    onChange: change((on) => (model.echo.sync = on)),
  });
  faderControl(parts.master, {
    label: "Master fader",
    value: model.master,
    onInput: change((v) => (model.master = v)),
  });

  for (const voice of VOICES) {
    parts.pads[voice].forEach((pad, step) => {
      pad.addEventListener("click", () => {
        pressStep(model.patterns[model.pattern], voice, step);
        renderPads();
      });
    });
  }
  for (const [name, btn] of Object.entries(parts.patterns)) {
    btn.addEventListener("click", () => choosePattern(name));
  }
  parts.start.addEventListener("click", () => start());
  parts.stop.addEventListener("click", () => stop());
}

function choosePattern(name) {
  if (clock.running && name !== model.pattern) model.queuedPattern = name;
  else {
    model.pattern = name;
    model.queuedPattern = null;
  }
  renderPatternButtons();
  renderPads();
}

function renderPads() {
  const p = model.patterns[model.pattern];
  for (const voice of VOICES) {
    parts.pads[voice].forEach((pad, step) => {
      const v = p[voice][step];
      pad.classList.toggle("on", Boolean(v));
      pad.setAttribute("aria-pressed", String(Boolean(v)));
      pad.querySelector("b").textContent = voice === "bl" && v ? v : "";
      const name = pad.dataset.label ?? (pad.dataset.label = pad.getAttribute("aria-label"));
      pad.setAttribute("aria-label", voice === "bl" && v ? `${name}, note ${v}` : name);
    });
  }
}

function renderPatternButtons() {
  for (const [name, btn] of Object.entries(parts.patterns)) {
    const on = name === model.pattern;
    const queued = name === model.queuedPattern;
    btn.classList.toggle("lit", on || queued);
    btn.style.setProperty("--cap", on ? "#f0c94a" : queued ? "#f6dc8a" : "#d9d4c8");
    btn.setAttribute("aria-pressed", String(on));
  }
}

function renderTransport() {
  parts.start.classList.toggle("lit", clock.running);
  parts.start.setAttribute("aria-pressed", String(clock.running));
  parts.cursor.style.opacity = clock.running ? "1" : "0";
}

function renderDisplay() {
  const d = parts.display;
  const shown =
    busy && !clock.running ? "---" : String(model.pendingBpm ?? model.bpm).padStart(3, " ");
  d.innerHTML = `${sevenSeg(shown)}<div class="glass"></div>`;
  d.classList.toggle("blink", Boolean(model.pendingBpm) && clock.running);
  d.setAttribute(
    "aria-label",
    `Tempo ${model.bpm} bpm${model.pendingBpm ? `, changing to ${model.pendingBpm}` : ""}`,
  );
}

/* ------------------------------------------------------------------ meters and cursor */

const needles = [createNeedle(), createNeedle()];
const ledLevels = parts.strips.map(() => -60);
const timeData = new Float32Array(2048);
const vuAngle = (vu) => {
  const lin = (d) => Math.pow(10, d / 20);
  const v = Math.max(-40, Math.min(3.6, vu));
  return -36 + (72 * (lin(v) - lin(-20))) / (lin(3) - lin(-20));
};

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (audio) {
    const t = audio.ctx.currentTime;
    // The cursor shows the step actually sounding, not the one being scheduled.
    while (clock.ahead.length > 1 && clock.ahead[1].time <= t) clock.ahead.shift();
    const cur = clock.ahead[0];
    if (cur && cur.time <= t) parts.cursor.style.left = `${parts.colX(cur.step)}px`;

    audio.strips.forEach((s, i) => {
      s.meter.getFloatTimeDomainData(timeData.subarray(0, 512));
      let peak = 0;
      for (let k = 0; k < 512; k++) peak = Math.max(peak, Math.abs(timeData[k]));
      const level = peak > 0 ? 20 * Math.log10(peak) : -60;
      ledLevels[i] = level > ledLevels[i] ? level : Math.max(level, ledLevels[i] - dt * 30);
      const lit = Math.round(((ledLevels[i] + 40) / 46) * 22);
      parts.strips[i].leds.forEach((led, k) => led.classList.toggle("on", k < lit));
    });
    audio.master.vu.forEach((a, ch) => {
      a.getFloatTimeDomainData(timeData);
      const target = vuAngle(rmsDb(timeData) + 14);
      stepNeedle(needles[ch], clock.running ? target : vuAngle(-40), dt);
      parts.needles[ch].setAttribute(
        "transform",
        `rotate(${needles[ch].angle.toFixed(2)} ${VU.cx} ${VU.cy})`,
      );
    });
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ keys and fit */

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (
    (e.key === " " || e.key === "Enter") &&
    (t instanceof HTMLButtonElement || t?.getAttribute?.("role") === "slider")
  )
    return;
  const k = e.key.toLowerCase();
  if (k === " ") {
    e.preventDefault();
    if (clock.running) stop();
    else start();
  } else if (["a", "b", "c", "d"].includes(k)) {
    choosePattern(k.toUpperCase());
  }
});
document.addEventListener(
  "pointerdown",
  () => document.documentElement.classList.add("pointer"),
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Tab") document.documentElement.classList.remove("pointer");
});

function fit() {
  const w = innerWidth - 32;
  const s = innerWidth >= 700 ? Math.min(w / 1360, (innerHeight - 110) / 850) : w / 1360;
  document.documentElement.style.setProperty("--s", Math.max(0.3, Math.min(1.4, s)).toFixed(3));
}
addEventListener("resize", fit);
fit();

wire();
renderPads();
renderPatternButtons();
renderTransport();
renderDisplay();
document.documentElement.dataset.ready = "1";
requestAnimationFrame(frame);

/** For poking from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ model, clock, audio });
