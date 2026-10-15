/**
 * EKO hi-fi 1978: the only module that talks to the engine. The deck's tape is the engine's
 * queue; the EQ and amp are a composite insert; everything else on the panel is a gain,
 * a filter or a delay somewhere in that chain, or one of the generated noises in inputs.js.
 */
import { EkoWebEngine } from "../../../dist/index.js";
import { filesToEntries, makeDemoLoop } from "../shared/files.js";
import { createAmpChain, EQ_RANGE, SETTINGS, SPEAKERS, TAPE_MON } from "./audio/amp-chain.js";
import { createDeckChain, TAPE_LABELS, TAPE_TYPES } from "./audio/deck-chain.js";
import { createExtras, createInputStage, INPUT_LABELS, INPUTS } from "./audio/inputs.js";
import {
  BAND_LABELS,
  bandBins,
  bandEdges,
  bandLevels,
  createLadder,
  createNeedle,
  LADDER_ROWS,
  peakDb,
  REST_ANGLE,
  rmsDb,
  stepLadder,
  stepNeedle,
  VU_REF_DBFS,
  vuAngle,
} from "./audio/meters.js";
import { CASSETTE, cassette, tickRing, volumeScale, vuFace, VU_PIVOT } from "./ui/faces.js";
import { counterDrums, counterValue, tapeGeometry } from "./audio/tape.js";
import { VOLUME_MAX, volumeAngle, volumeDb } from "./audio/taper.js";
import { selector, slider, toggle } from "./ui/controls.js";

const $ = (sel) => document.querySelector(sel);
const engine = new EkoWebEngine({ normalize: true, transition: "gapless" });
// iOS mutes Web Audio with the ring switch unless the page says it is a music player.
if (navigator.audioSession) navigator.audioSession.type = "playback";

/** Every panel setting. The audio graph is built from this after the first gesture. */
const model = {
  ...SETTINGS,
  bands: [...SETTINGS.bands],
  input: "tape",
  dolby: true,
  tapeType: "normal",
};

/** The deck: what is on the tape and what the transport is doing. */
const deck = {
  entries: [],
  loaded: false,
  stopped: true,
  paused: false,
  recording: false,
  counterResetAt: 0,
  winding: 0,
  /** Ran off the end of the side. PLAY then rewinds, unless you have moved the tape since. */
  atEnd: false,
};
let nextId = 0;

/* ------------------------------------------------------------------ audio graph */

let audio = null;

/**
 * Reading engine.context creates the AudioContext, so this only runs from inside a click,
 * key press or drop. Two copies of the amp: one is the engine's insert (the deck), the other
 * carries the tuner, aux and phono noises, which must keep sounding while the deck is paused.
 */
function ensureAudio() {
  if (audio) return audio;
  const ctx = engine.context;
  const tape = createDeckChain(ctx);
  const stage = createInputStage(ctx);
  const ampDeck = createAmpChain(ctx);
  const ampExtras = createAmpChain(ctx);
  const extras = createExtras(ctx);
  engine.setInserts([tape, ...stage.nodes, ampDeck]);

  extras.output.connect(ampExtras.input);
  ampExtras.output.connect(ctx.destination);

  // The meter bus hears what the speakers hear: the engine's output plus the extras path.
  const bus = ctx.createGain();
  bus.channelCount = 2;
  bus.channelCountMode = "explicit";
  bus.channelInterpretation = "speakers";
  engine.analyser.connect(bus);
  ampExtras.output.connect(bus);

  const stereoTap = (source) => {
    const split = ctx.createChannelSplitter(2);
    source.connect(split);
    return [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      split.connect(a, ch);
      return a;
    });
  };
  const vu = stereoTap(bus);
  const deckLevel = stereoTap(tape.tap);
  const spectrum = ctx.createAnalyser();
  spectrum.fftSize = 4096;
  spectrum.smoothingTimeConstant = 0.55;
  bus.connect(spectrum);
  const record = ctx.createMediaStreamDestination ? ctx.createMediaStreamDestination() : null;
  if (record) bus.connect(record);

  audio = {
    ctx,
    tape,
    stage,
    amps: [ampDeck, ampExtras],
    extras,
    vu,
    deckLevel,
    spectrum,
    record,
    bins: bandBins(bandEdges(), ctx.sampleRate, spectrum.fftSize),
    timeData: new Float32Array(2048),
    freqData: new Float32Array(spectrum.frequencyBinCount),
  };
  applyAudio();

  // The tuner's distant station is the demo loop, heard through a band-pass.
  makeDemoLoop()
    .arrayBuffer()
    .then((b) => ctx.decodeAudioData(b))
    .then((buffer) => extras.setStation(buffer))
    .catch(() => {});
  return audio;
}

function applyAudio() {
  if (!audio) return;
  for (const amp of audio.amps) amp.set(model);
  audio.tape.set(model);
  audio.stage.set(model.input);
  audio.extras.set(model.input, deckRunning());
}

const deckRunning = () => deck.loaded && !deck.stopped && !deck.paused;

/** A relay closing: a few milliseconds of filtered click, straight to the speakers. */
function relayClick() {
  if (!audio) return;
  const { ctx } = audio;
  const n = Math.round(ctx.sampleRate * 0.004);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 6)) * 0.08;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

let relayTimer = 0;
function setPower(on) {
  model.power = on;
  clearTimeout(relayTimer);
  if (!audio) return applyAudio();
  if (!on) {
    for (const amp of audio.amps) amp.setRelay(false, model);
    return;
  }
  // The protection relay holds the speakers off while the output stage settles.
  for (const amp of audio.amps) amp.setRelay(false, model);
  relayTimer = setTimeout(() => {
    relayClick();
    for (const amp of audio.amps) amp.setRelay(true, model);
  }, 1200);
}

/* ------------------------------------------------------------------ the tape */

function demoParts() {
  const loop = makeDemoLoop();
  return [1, 2, 3].map(
    (n) => new File([loop], `EKO - Demo Loop (Part ${n}).wav`, { type: "audio/wav" }),
  );
}

/** The latest load in flight. Only the newest one gets to put its tape in the deck. */
let loading = null;
let loadToken = 0;
/** Bumped by every transport press, so a PLAY still waiting on a load can tell it was overruled. */
let transportSeq = 0;

function startLoad(files, opts) {
  const p = loadTape(files, opts);
  loading = p;
  return p.finally(() => {
    if (loading === p) loading = null;
  });
}

/** A new cassette: whatever was in the deck comes out, and the new one goes in at the start. */
async function loadTape(files, { autoplay = true } = {}) {
  const token = ++loadToken;
  const idStart = nextId;
  nextId += files.length;
  const entries = await filesToEntries(files, idStart);
  if (token !== loadToken) {
    entries.forEach((e) => URL.revokeObjectURL(e.url));
    return false;
  }
  if (entries.length === 0) {
    say("No audio in that. The deck takes MP3, WAV, FLAC, OGG and friends.");
    closeDoor();
    return false;
  }
  const old = deck.entries;
  deck.entries = entries;
  deck.loaded = true;
  deck.stopped = true;
  deck.paused = false;
  deck.atEnd = false;
  deck.counterResetAt = 0;
  engine.setQueue(
    entries.map((e) => e.track),
    0,
  );
  ensureAudio();
  old.forEach((e) => URL.revokeObjectURL(e.url));
  closeDoor();
  renderTape();
  if (autoplay) await play();
  return true;
}

async function play() {
  // Safari only lets audio start inside the gesture, so wake the context before any await.
  engine.context.resume().catch(() => {});
  ensureAudio();
  const seq = ++transportSeq;
  if (!deck.loaded) {
    if (loading) {
      // A tape is already on its way in (a drop, the picker, or the demo): wait for it.
      await loading;
    } else if (deck.entries.length) {
      deck.loaded = true;
      closeDoor();
    } else {
      await startLoad(demoParts(), { autoplay: false });
    }
    if (seq !== transportSeq || !deck.loaded) return;
  }
  if (deck.atEnd) engine.skipTo(0);
  deck.atEnd = false;
  if (engine.state === "error") {
    // This song would not decode: try the next one, or give up and say so.
    if (engine.currentIndex < deck.entries.length - 1) {
      engine.skipTo(engine.currentIndex + 1);
    } else {
      say("The deck cannot play this tape. Try other files.");
      return;
    }
  }
  deck.stopped = false;
  deck.paused = false;
  applyAudio();
  renderKeys();
  await engine.play();
}

/** Pause latches, like the real key: press again to release it. */
function pause() {
  if (deck.stopped) return;
  transportSeq += 1;
  deck.paused = !deck.paused;
  if (deck.paused) engine.pause();
  else engine.play();
  applyAudio();
  renderKeys();
}

/** Stop leaves the tape where it is, the way a deck does. */
function stop() {
  transportSeq += 1;
  engine.pause();
  deck.stopped = true;
  deck.paused = false;
  applyAudio();
  renderKeys();
}

function skip(delta) {
  if (!deck.loaded) return;
  deck.atEnd = false;
  const last = deck.entries.length - 1;
  const at = engine.currentIndex;
  if (delta < 0) {
    // Like the deck's music search: back to the start of this song first, then the one before.
    if (engine.currentTime > 3 || at === 0) engine.seek(0);
    else engine.skipTo(at - 1);
  } else if (at < last) {
    engine.skipTo(at + 1);
  }
  if (!deck.stopped && !deck.paused) engine.play();
}

/** Held REW or FF: wind through the tape, the spools a blur. */
let windTimer = 0;
/** Winding back into the previous song: land near its end once it has loaded. */
let windToEndOf = -1;
function startWind(dir) {
  if (!deck.loaded) return;
  deck.winding = dir;
  deck.atEnd = false;
  windToEndOf = -1;
  windTimer = setInterval(() => {
    // Position and duration still describe the old song until a skip has loaded.
    if (engine.state === "loading") return;
    if (windToEndOf >= 0) {
      if (engine.currentIndex === windToEndOf && engine.duration > 0) {
        engine.seek(Math.max(0, engine.duration - 3));
      }
      windToEndOf = -1;
      return;
    }
    const t = engine.currentTime + dir * 3;
    if (t < 0 && engine.currentIndex > 0) {
      windToEndOf = engine.currentIndex - 1;
      engine.skipTo(windToEndOf);
    } else if (t > (engine.duration || 0) && engine.currentIndex < deck.entries.length - 1) {
      engine.skipTo(engine.currentIndex + 1);
    } else {
      engine.seek(Math.max(0, Math.min(t, engine.duration || 0)));
    }
  }, 110);
}
function stopWind() {
  clearInterval(windTimer);
  deck.winding = 0;
}

/* ------------------------------------------------------------------ eject and files */

const picker = document.createElement("input");
picker.type = "file";
picker.multiple = true;
picker.accept = "audio/*";
picker.hidden = true;
document.body.appendChild(picker);

let pickerOpen = false;
let pickerFallback = 0;
picker.addEventListener("change", () => {
  pickerOpen = false;
  clearTimeout(pickerFallback);
  const files = [...picker.files];
  picker.value = "";
  if (files.length) startLoad(files);
  else closeDoor();
});
// Cancelling the picker puts the old tape back.
picker.addEventListener("cancel", () => {
  pickerOpen = false;
  clearTimeout(pickerFallback);
  closeDoor();
});

function eject() {
  transportSeq += 1;
  engine.context.resume().catch(() => {});
  ensureAudio();
  if (!deck.stopped) stop();
  if (deck.recording) setRecording(false);
  deck.loaded = false;
  $("#bay").classList.add("open");
  $(".bay-empty").textContent = "Choose some music";
  renderTape();
  pickerOpen = true;
  picker.click();
  // Browsers without the picker's cancel event still give focus back when it closes. Focus
  // can arrive before `change` on a slow multi-file pick, so `change` cancels this.
  addEventListener(
    "focus",
    () => {
      clearTimeout(pickerFallback);
      pickerFallback = setTimeout(() => {
        if (!pickerOpen) return;
        pickerOpen = false;
        closeDoor();
      }, 2500);
    },
    { once: true },
  );
}

function closeDoor() {
  $("#bay").classList.remove("open");
  $(".bay-empty").textContent = "Push Eject to load";
  if (!pickerOpen && deck.entries.length) deck.loaded = true;
  renderTape();
}

for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  engine.context.resume().catch(() => {});
  startLoad([...e.dataTransfer.files]);
});

/* ------------------------------------------------------------------ recording */

let recorder = null;
let takeCount = 0;

function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function setRecording(on) {
  if (on === deck.recording) return renderRec();
  if (on) {
    engine.context.resume().catch(() => {});
    const a = ensureAudio();
    const type = recordingType();
    if (type === null || !a.record) {
      say("This browser cannot record. The REC lamp stays dark.");
      return renderRec();
    }
    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(a.record.stream, type ? { mimeType: type } : undefined);
      rec.start();
    } catch {
      say("The recorder would not start in this browser.");
      return renderRec();
    }
    recorder = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
      const link = $("#takeLink");
      if (link.href) URL.revokeObjectURL(link.href);
      takeCount += 1;
      const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      link.href = URL.createObjectURL(blob);
      link.download = `eko-hifi-take-${takeCount}.${ext}`;
      link.textContent = `Download take ${takeCount}`;
      $("#take").hidden = false;
    };
    deck.recording = true;
    say("Recording what the amp plays. Flip REC/PLAY or press REC again to stop.");
  } else {
    recorder?.stop();
    recorder = null;
    deck.recording = false;
    say("Take saved: the download link is below the stack.");
  }
  renderRec();
}

/* ------------------------------------------------------------------ panel */

let sayTimer = 0;
function say(text) {
  const el = $("#status");
  el.textContent = text;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => (el.textContent = ""), 4200);
}

function setKnobAngle(el, deg) {
  el.style.setProperty("--r", `${deg}deg`);
}

/** Any panel change: wake the audio (we are inside a gesture), then apply. */
function change(patch) {
  Object.assign(model, patch);
  engine.context.resume().catch(() => {});
  ensureAudio();
  applyAudio();
  if ("tapeType" in patch) renderTape();
}

const signed = (unit) => (v) => `${v > 0 ? "+" : ""}${v} ${unit}`;

function buildFaders() {
  const wrap = $("#faders");
  const x0 = 350;
  const dx = 19.5;
  let html = "";
  html += `<div class="lg dim" style="left:322px;top:19px;font-size:5px">+12</div>`;
  html += `<div class="lg dim" style="left:330px;top:52px;font-size:5px">0</div>`;
  html += `<div class="lg dim" style="left:323px;top:85px;font-size:5px">−12</div>`;
  for (let k = 0; k <= 8; k++) {
    const y = 23 + k * 8;
    const w = k === 4 ? 194 : 186;
    html += `<div class="fscale" style="left:${k === 4 ? 338 : 342}px;top:${y}px;width:${w}px;opacity:${k === 4 ? 0.9 : 0.45}"></div>`;
  }
  BAND_LABELS.forEach((label, i) => {
    const x = x0 + i * dx;
    html += `<div class="fslot" style="left:${x - 2}px"></div>`;
    html += `<div class="fader" data-band="${i}" style="left:${x}px"><div class="ftrack"></div><div class="fcap"></div></div>`;
    html += `<div class="lg c" style="left:${x}px;top:96px;font-size:5.5px;letter-spacing:.3px">${label}</div>`;
  });
  html += `<div class="lg dim" style="left:350px;top:105px;font-size:5px;letter-spacing:1.2px">Frequency Hz</div>`;
  wrap.innerHTML = html;
  for (const el of wrap.querySelectorAll(".fader")) {
    const i = Number(el.dataset.band);
    const cap = el.querySelector(".fcap");
    slider(el, {
      label: `${BAND_LABELS[i]} Hz`,
      min: -EQ_RANGE,
      max: EQ_RANGE,
      step: 0.5,
      bigStep: 3,
      value: model.bands[i],
      detent: 0,
      vertical: true,
      track: el.querySelector(".ftrack"),
      format: signed("dB"),
      render: (v) => (cap.style.top = `${37 - v * 2.6}px`),
      onInput: (v) => {
        const bands = [...model.bands];
        bands[i] = v;
        change({ bands });
      },
    });
  }
}

function buildPanel() {
  for (const svg of document.querySelectorAll("svg.ticks[data-ticks]")) {
    tickRing(svg, Number(svg.dataset.ticks), Number(svg.dataset.span));
  }
  volumeScale($("#volTicks"), ["∞", "60", "40", "30", "20", "15", "10", "5", "0"]);
  needles = [vuFace($("#meterL"), "L"), vuFace($("#meterR"), "R")];
  tapeParts = cassette($("#cassette"));
  for (const reel of document.querySelectorAll(".reel")) {
    reel.innerHTML = Array.from({ length: 11 }, (_, i) => `<span>${i % 10}</span>`).join("");
  }
  buildFaders();

  slider($("#volume"), {
    label: "Volume",
    min: 0,
    max: VOLUME_MAX,
    step: 0.05,
    bigStep: 1,
    travel: 260,
    value: model.volume,
    format: (v) => {
      const db = volumeDb(v);
      return db === -Infinity ? "off" : `${db.toFixed(0)} dB`;
    },
    render: (v) => setKnobAngle($("#volume"), volumeAngle(v)),
    onInput: (v) => change({ volume: v }),
  });

  const tone = (id, label, unit, range, step) =>
    slider($(id), {
      label,
      min: -range,
      max: range,
      step,
      value: model[id.slice(1)],
      detent: 0,
      format:
        unit === "dB"
          ? signed("dB")
          : (v) =>
              v === 0 ? "centre" : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? "left" : "right"}`,
      render: (v) => setKnobAngle($(id), (v / range) * 135),
      onInput: (v) => change({ [id.slice(1)]: v }),
    });
  tone("#bass", "Bass", "dB", 10, 0.5);
  tone("#treble", "Treble", "dB", 10, 0.5);
  tone("#balance", "Balance", "", 1, 0.05);

  const rotary = (id, label, key, options, labels, angles) =>
    selector($(id), {
      label,
      options,
      labels,
      value: model[key],
      render: (_, i) => setKnobAngle($(id), angles[i]),
      onInput: (v) => change({ [key]: v }),
    });
  rotary("#speakers", "Speakers", "speakers", SPEAKERS, {}, [-70, 0, 70]);
  rotary(
    "#tapeMon",
    "Tape monitor echo",
    "tapeMon",
    TAPE_MON,
    { off: "Off", short: "Short echo", long: "Long echo", dub: "Dub echo" },
    [-90, -30, 30, 90],
  );
  rotary("#input", "Input", "input", INPUTS, INPUT_LABELS, [-60, -20, 20, 60]);
  rotary("#tapeType", "Tape type", "tapeType", TAPE_TYPES, TAPE_LABELS, [-45, 0, 45]);

  const lever = (id, label, key, invert = false) =>
    toggle($(id), {
      label,
      value: model[key],
      render: (on) => $(id).classList.toggle("down", invert ? on : !on),
      onChange: (on) => change({ [key]: on }),
    });
  lever("#loud", "Loudness", "loud");
  lever("#low", "Low filter", "low");
  lever("#high", "High filter", "high");
  lever("#mono", "Mono", "mono");
  lever("#defeat", "EQ defeat", "eqDefeat", true);

  recLever = toggle($("#recPlay"), {
    label: "Record switch on the equalizer",
    value: false,
    render: (on) => $("#recPlay").classList.toggle("down", !on),
    onChange: (on) => setRecording(on),
  });

  const push = (id, label, key, led, onChange) =>
    toggle($(id), {
      label,
      value: model[key],
      render: (on) => {
        $(id).classList.toggle("in", on);
        document.querySelector(`[data-led="${led}"]`).classList.toggle("on", on);
      },
      onChange,
    });
  push("#eqPower", "Equalizer power", "eqPower", "eqPower", (on) => change({ eqPower: on }));
  push("#dolby", "Dolby noise reduction", "dolby", "dolby", (on) => {
    change({ dolby: on });
    say(
      on
        ? "Dolby NR in: clean."
        : `Dolby NR out: you are hearing the ${TAPE_LABELS[model.tapeType]} tape.`,
    );
  });
  push("#ampPower", "Amplifier power", "power", "ampPower", (on) => {
    engine.context.resume().catch(() => {});
    ensureAudio();
    setPower(on);
    $("#meterwin").classList.toggle("lit", on);
  });
  $("#meterwin").classList.toggle("lit", model.power);

  toggle($("#phones"), {
    label: "Headphones",
    value: model.phones,
    render: (on) => $("#phones").classList.toggle("in", on),
    onChange: (on) => {
      change({ phones: on });
      say(on ? "Headphones in: crossfeed on, like speakers in a room." : "Headphones out.");
    },
  });

  $("#counterReset").setAttribute("aria-label", "Reset tape counter");
  $("#counterReset").addEventListener("click", () => {
    deck.counterResetAt = geometry().takeupTurns;
  });

  // Transport keys. REW and FF: a click skips, a hold winds.
  for (const key of document.querySelectorAll(".key")) {
    const name = key.dataset.key;
    if (name === "rew" || name === "ff") {
      let held = 0;
      let wound = false;
      key.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        wound = false;
        held = setTimeout(() => {
          wound = true;
          key.classList.add("down");
          startWind(name === "ff" ? 1 : -1);
        }, 380);
      });
      const release = () => {
        clearTimeout(held);
        if (wound) {
          stopWind();
          key.classList.remove("down");
        }
      };
      key.addEventListener("pointerup", release);
      key.addEventListener("pointerleave", release);
      key.addEventListener("pointercancel", release);
      key.addEventListener("click", () => {
        if (wound) return;
        skip(name === "ff" ? 1 : -1);
      });
    } else {
      key.addEventListener("click", () => run(name));
    }
  }
}

let recLever = null;

function run(name) {
  const actions = {
    play: () => play(),
    pause: () => pause(),
    stop: () => stop(),
    eject: () => eject(),
    rec: () => setRecording(!deck.recording),
    next: () => skip(1),
    prev: () => skip(-1),
  };
  Promise.resolve(actions[name]?.()).catch((err) => {
    say(`The deck stopped: ${err?.code || err?.name || "playback error"}.`);
    stop();
  });
}

function renderKeys() {
  const playing = deck.loaded && !deck.stopped;
  document.querySelector('[data-key="play"]').classList.toggle("down", playing);
  document.querySelector('[data-key="pause"]').classList.toggle("down", playing && deck.paused);
  document.querySelector('[data-key="play"]').setAttribute("aria-pressed", String(playing));
  document
    .querySelector('[data-key="pause"]')
    .setAttribute("aria-pressed", String(playing && deck.paused));
}

function renderRec() {
  document.querySelector('[data-key="rec"]').classList.toggle("down", deck.recording);
  document.querySelector('[data-key="rec"]').setAttribute("aria-pressed", String(deck.recording));
  recLever?.set(deck.recording);
}

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The cassette in the window: loaded or not, and the current song on its label. */
function renderTape() {
  $("#bay").classList.toggle("loaded", deck.loaded);
  const entry = deck.entries[Math.max(0, engine.currentIndex)];
  tapeParts.title.textContent = entry ? entry.title : "";
  tapeParts.type.textContent =
    model.tapeType === "normal"
      ? "60 MIN  ·  TYPE I  ·  NORMAL BIAS"
      : model.tapeType === "cro2"
        ? "60 MIN  ·  TYPE II  ·  HIGH BIAS"
        : "60 MIN  ·  TYPE IV  ·  METAL";
}

/* ------------------------------------------------------------------ engine events */

engine.on("trackchange", () => renderTape());
engine.on("ended", () => {
  deck.stopped = true;
  deck.paused = false;
  deck.atEnd = true;
  applyAudio();
  renderKeys();
  say("End of side A. Press PLAY to rewind and go again.");
});
engine.on("error", ({ error }) => {
  say(`The deck could not play that: ${error.code}.`);
  deck.stopped = true;
  deck.paused = false;
  applyAudio();
  renderKeys();
});

/* ------------------------------------------------------------------ keyboard */

const KEYS = { " ": "toggle", s: "stop", n: "next", p: "prev", e: "eject" };
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLButtonElement || t?.getAttribute?.("role") === "slider") {
    if (e.key === " " || e.key === "Enter") return;
  }
  const action = KEYS[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  if (action === "toggle") run(deck.stopped ? "play" : "pause");
  else run(action);
});

// Focus rings only while tabbing: a knob grabbed with the mouse should not light up.
document.addEventListener(
  "pointerdown",
  () => document.documentElement.classList.add("pointer"),
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Tab") document.documentElement.classList.remove("pointer");
});

/* ------------------------------------------------------------------ fit to the window */

function fit() {
  // The stack sits at about 60% of the window, like a real one on a shelf, with room around
  // it. Narrow screens use the full width instead, so it stays usable by touch.
  const fill = Math.min((innerWidth - 32) / 592, (innerHeight - 140) / 480);
  const s = innerWidth >= 700 ? Math.max(0.9, fill * 0.6) : Math.max(0.5, (innerWidth - 32) / 592);
  document.documentElement.style.setProperty("--s", s.toFixed(3));
}
addEventListener("resize", fit);
fit();

/* ------------------------------------------------------------------ the frame loop */

let needles = [];
let tapeParts = null;
const needleState = [createNeedle(), createNeedle()];
const peakHold = [0, 0];
const deckPeak = [-60, -60];
const ladder = createLadder();
const ladderTargets = new Float32Array(10);
const ladderCanvas = $("#ladder");
const ladderCtx = ladderCanvas.getContext("2d");
const deckCanvas = $("#deckMeter");
const deckCtx = deckCanvas.getContext("2d");
let windSpin = 0;

function geometry() {
  if (!deck.entries.length) return tapeGeometry(0, 0);
  const total = deck.entries.reduce((s, e) => s + (e.durationSec || 0), 0);
  const before = deck.entries
    .slice(0, Math.max(0, engine.currentIndex))
    .reduce((s, e) => s + (e.durationSec || 0), 0);
  return tapeGeometry(before + (engine.currentTime || 0), total);
}

function drawLadder(lit) {
  const W = ladderCanvas.width;
  const H = ladderCanvas.height;
  ladderCtx.clearRect(0, 0, W, H);
  const padX = 8;
  const colW = (W - padX * 2) / 10;
  const segH = (H - 8) / LADDER_ROWS;
  for (let c = 0; c < 10; c++) {
    const on = lit ? Math.round(ladder.levels[c] * LADDER_ROWS) : 0;
    const pk = lit ? Math.round(ladder.peaks[c] * LADDER_ROWS) : 0;
    for (let r = 0; r < LADDER_ROWS; r++) {
      const x = padX + c * colW + 4;
      const y = H - 4 - (r + 1) * segH + 2;
      const hot = r >= LADDER_ROWS - 2;
      const warm = r >= LADDER_ROWS - 5;
      const col = hot ? "255,58,30" : warm ? "255,170,40" : "255,124,36";
      const isLit = r < on || (pk > 0 && r === pk - 1);
      ladderCtx.shadowBlur = isLit ? 8 : 0;
      ladderCtx.shadowColor = `rgba(${col},.9)`;
      ladderCtx.fillStyle = isLit ? `rgb(${col})` : `rgba(${col},${lit ? 0.09 : 0.04})`;
      ladderCtx.fillRect(x, y, colW - 8, segH - 3.2);
    }
  }
  ladderCtx.shadowBlur = 0;
}

/** The deck's fluorescent bar meters: 24 segments from -30 to +6 dB, 0 dB at -6 dBFS. */
function drawDeckMeter(levels, recLit) {
  const W = deckCanvas.width;
  const H = deckCanvas.height;
  deckCtx.clearRect(0, 0, W, H);
  const segs = 22;
  const x0 = 26;
  // The right end of the display holds the REC indicator, as fluorescent decks did.
  const recW = 46;
  const segW = (W - x0 - recW - 10) / segs;
  deckCtx.font = "600 11px Archivo, sans-serif";
  ["L", "R"].forEach((ch, row) => {
    const y = 10 + row * 22;
    deckCtx.fillStyle = "rgba(255,150,60,.55)";
    deckCtx.fillText(ch, 9, y + 10);
    const db = levels[row] + 6;
    const on = Math.round(((db + 30) / 36) * segs);
    for (let i = 0; i < segs; i++) {
      const hot = i >= Math.round((30 / 36) * segs);
      const col = hot ? "255,64,36" : "255,140,46";
      const lit = i < on;
      deckCtx.shadowBlur = lit ? 6 : 0;
      deckCtx.shadowColor = `rgba(${col},.8)`;
      deckCtx.fillStyle = lit ? `rgb(${col})` : `rgba(${col},.08)`;
      deckCtx.fillRect(x0 + i * segW + 1, y, segW - 3, 12);
    }
  });
  const rx = W - recW + 2;
  deckCtx.fillStyle = "rgba(255,150,60,.12)";
  deckCtx.fillRect(rx - 8, 8, 1, H - 16);
  deckCtx.font = "700 14px Archivo, sans-serif";
  deckCtx.textAlign = "center";
  deckCtx.shadowColor = "rgba(255,50,30,.9)";
  deckCtx.shadowBlur = recLit ? 8 : 0;
  deckCtx.fillStyle = recLit ? "rgb(255,70,44)" : "rgba(255,70,44,.12)";
  deckCtx.fillText("REC", rx + recW / 2 - 6, H / 2 + 5);
  deckCtx.textAlign = "start";
  deckCtx.shadowBlur = 0;
}

const drumEls = [...document.querySelectorAll(".reel")];

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const a = audio;
  const powered = model.power;

  // VU needles: RMS per channel against 0 VU, falling back to the pin when the amp is off.
  for (let ch = 0; ch < 2; ch++) {
    let target = REST_ANGLE;
    if (a && powered) {
      a.vu[ch].getFloatTimeDomainData(a.timeData);
      const rms = rmsDb(a.timeData);
      target = vuAngle(rms - VU_REF_DBFS);
      if (peakDb(a.timeData) > -1.5 || rms - VU_REF_DBFS > 1.5) peakHold[ch] = 0.15;
    }
    stepNeedle(needleState[ch], target, dt);
    needles[ch]?.setAttribute(
      "transform",
      `rotate(${needleState[ch].angle.toFixed(2)} ${VU_PIVOT[0]} ${VU_PIVOT[1]})`,
    );
    peakHold[ch] = Math.max(0, peakHold[ch] - dt);
    document
      .querySelector(`[data-led="peak${ch ? "R" : "L"}"]`)
      .classList.toggle("on", peakHold[ch] > 0);
  }

  // The G-110's ladder shows what is coming out of the amp, while its own power is on.
  const eqLit = model.eqPower && powered;
  if (a && eqLit) {
    a.spectrum.getFloatFrequencyData(a.freqData);
    bandLevels(a.freqData, a.bins, ladderTargets);
  } else {
    ladderTargets.fill(0);
  }
  stepLadder(ladder, ladderTargets, dt);
  drawLadder(eqLit);

  // The deck's own meters read the tape, before the amp.
  for (let ch = 0; ch < 2; ch++) {
    let db = -60;
    if (a && deckRunning()) {
      a.deckLevel[ch].getFloatTimeDomainData(a.timeData);
      db = peakDb(a.timeData);
    }
    deckPeak[ch] = db > deckPeak[ch] ? db : Math.max(db, deckPeak[ch] - dt * 24);
  }
  drawDeckMeter(deckPeak, deck.recording && Math.floor(now / 500) % 2 === 0);

  // Spools and counter.
  if (tapeParts) {
    const g = geometry();
    windSpin += deck.winding * dt * 5;
    const [p1, p2] = tapeParts.packs;
    p1.setAttribute("r", (g.supply * CASSETTE.pxPerMm).toFixed(2));
    p2.setAttribute("r", (g.takeup * CASSETTE.pxPerMm).toFixed(2));
    const turns = [g.supplyTurns + windSpin, g.takeupTurns + windSpin];
    tapeParts.hubs.forEach((hub, i) => {
      const [cx, cy] = CASSETTE.hubs[i];
      hub.setAttribute("transform", `rotate(${((turns[i] * 360) % 360).toFixed(1)} ${cx} ${cy})`);
    });
    const drums = counterDrums(counterValue(g.takeupTurns, deck.counterResetAt));
    drums.forEach((d, i) => {
      drumEls[i].style.transform = `translateY(${(-d * 13 + 2).toFixed(2)}px)`;
    });
  }

  if (a) a.extras.tick(dt);
  requestAnimationFrame(frame);
}

buildPanel();
renderTape();
renderKeys();
renderRec();
document.documentElement.dataset.ready = "1";
requestAnimationFrame(frame);
// Keep the tape's files alive if the page is only going into the back/forward cache.
addEventListener("pagehide", (e) => {
  if (e.persisted) return;
  deck.entries.forEach((entry) => URL.revokeObjectURL(entry.url));
  const take = $("#takeLink").href;
  if (take) URL.revokeObjectURL(take);
});

/** For poking at the stack from the console: import("./app.js").then((m) => m.inspect()). */
export const inspect = () => ({ engine, model, deck, audio });
