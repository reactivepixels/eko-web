/**
 * Presets, MilkDrop style: each one is a per-frame equation from time and the audio numbers
 * (bass, mid, treb and their _att versions) to the warp, the decay and the waves. Changing
 * preset blends every number across a couple of seconds, as MilkDrop does.
 */

export const BLEND_SECONDS = 2.7;

/** What every preset starts from. Colours are [r, g, b] in 0..1. */
export const DEFAULTS = {
  zoom: 1,
  rot: 0,
  swirl: 0,
  warp: 0,
  warpSpeed: 1,
  warpScale: 1,
  cx: 0.5,
  cy: 0.5,
  dx: 0,
  dy: 0,
  decay: 0.96,
  kaleido: 0,
  hue: 0,
  echo: 0,
  echoZoom: 1,
  gamma: 1,
  bg: [0.02, 0.02, 0.05],
  wave: "ring",
  waveScale: 1,
  waveAlpha: 1,
  waveA: [1, 0.48, 0.16],
  waveB: [0.37, 0.83, 1],
  comets: 0,
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const ORANGE = rgb("#ff7a2a");
const CYAN = rgb("#5fd3ff");

/** @typedef {{ t: number, bass: number, mid: number, treb: number, bass_att: number,
 *   mid_att: number, treb_att: number, beat: boolean }} Frame */

export const PRESETS = [
  {
    name: "eko_ember_tunnel_v3",
    rating: 4,
    frame: (f) => ({
      zoom: 1.018 + 0.03 * (f.bass_att - 1),
      rot: 0.004,
      swirl: 0.55 + 0.2 * Math.sin(f.t * 0.13),
      warp: 0.5 + 0.4 * f.mid_att,
      decay: 0.955,
      bg: [0.03, 0.025, 0.07],
      wave: "ring",
      waveScale: 1 + 0.1 * (f.bass_att - 1),
      waveA: ORANGE,
      waveB: CYAN,
      comets: 6,
    }),
  },
  {
    name: "kaleido_drift",
    rating: 4,
    frame: (f) => ({
      zoom: 0.996 + 0.01 * (f.bass_att - 1),
      rot: 0.012 * Math.sin(f.t * 0.21),
      warp: 0.9,
      warpSpeed: 0.7,
      kaleido: 6,
      decay: 0.955,
      hue: 0.002,
      bg: [0.04, 0.015, 0.05],
      wave: "spectrumRing",
      waveA: rgb("#ff4f9a"),
      waveB: rgb("#ffc65c"),
    }),
  },
  {
    name: "ion_storm",
    rating: 3,
    frame: (f) => ({
      zoom: 1.03 + (f.beat ? 0.06 : 0) + 0.02 * (f.bass - 1),
      rot: 0.002 * Math.sin(f.t * 0.5),
      warp: 1.6 + 0.6 * f.treb_att,
      warpSpeed: 1.6,
      warpScale: 1.4,
      decay: 0.93,
      hue: 0.004,
      bg: [0.01, 0.03, 0.06],
      wave: "scope",
      waveScale: 1.2,
      waveA: CYAN,
      waveB: [0.92, 0.95, 1],
    }),
  },
  {
    name: "glass_orbit",
    rating: 5,
    frame: (f) => ({
      zoom: 0.988,
      rot: -0.006 - 0.004 * (f.mid_att - 1),
      swirl: -0.3,
      warp: 0.35,
      decay: 0.972,
      bg: [0.01, 0.035, 0.045],
      wave: "lissajous",
      waveScale: 0.9 + 0.2 * f.bass_att,
      waveA: rgb("#38e0c8"),
      waveB: rgb("#ffb347"),
      comets: 10,
    }),
  },
  {
    name: "sodium_rain",
    rating: 3,
    frame: (f) => ({
      zoom: 1.004,
      dy: -0.007 - 0.003 * (f.treb_att - 1),
      warp: 0.15,
      warpScale: 2,
      decay: 0.968,
      bg: [0.05, 0.025, 0.01],
      wave: "bars",
      waveA: rgb("#ff9a2e"),
      waveB: rgb("#ffd88a"),
    }),
  },
  {
    name: "tide_pool",
    rating: 4,
    frame: (f) => ({
      zoom: 1.002,
      rot: 0.003,
      swirl: 1.15 + 0.3 * Math.sin(f.t * 0.07),
      warp: 0.6,
      warpSpeed: 0.5,
      decay: 0.98,
      echo: 0.35,
      echoZoom: 1.25,
      bg: [0.01, 0.03, 0.07],
      wave: "ring",
      waveScale: 0.7 + 0.1 * (f.treb_att - 1),
      waveA: rgb("#4fd8ff"),
      waveB: rgb("#3a6cff"),
    }),
  },
  {
    name: "mirror_halls",
    rating: 4,
    frame: (f) => ({
      zoom: 1.012 + 0.02 * (f.bass_att - 1),
      rot: 0.0,
      warp: 0.25,
      kaleido: 4,
      decay: 0.955,
      echo: 0.5,
      echoZoom: 1.6,
      bg: [0.03, 0.025, 0.04],
      wave: "spiral",
      waveA: [1, 0.95, 0.9],
      waveB: ORANGE,
    }),
  },
  {
    name: "carrier_wave",
    rating: 3,
    frame: (f) => ({
      zoom: 1.01,
      rot: 0.02 * (f.mid_att - 1) + 0.004,
      swirl: 0.25,
      warp: 0.7,
      decay: 0.962,
      hue: -0.003,
      bg: [0.035, 0.015, 0.06],
      wave: "dots",
      waveA: rgb("#b48cff"),
      waveB: ORANGE,
      comets: 4,
    }),
  },
];

export const presetFile = (p) => `${p.name}.milk`;

/** A preset's numbers for this frame, over the defaults. */
export function evaluate(preset, frame) {
  return { ...DEFAULTS, ...preset.frame(frame) };
}

const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Blend two parameter sets. Numbers and colours ease across; the things that cannot be
 * halfway (wave shape, kaleidoscope folds, comet count) switch at the midpoint, where the
 * waves are dimmed so the swap is not a jump.
 */
export function blend(a, b, k) {
  const e = k * k * (3 - 2 * k);
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const x = a[key];
    const y = b[key];
    if (typeof x === "number" && typeof y === "number") out[key] = lerp(x, y, e);
    else if (Array.isArray(x) && Array.isArray(y)) out[key] = x.map((v, i) => lerp(v, y[i], e));
    else out[key] = e < 0.5 ? x : y;
  }
  out.kaleido = e < 0.5 ? a.kaleido : b.kaleido;
  out.comets = e < 0.5 ? a.comets : b.comets;
  out.waveAlpha *= 1 - 0.7 * Math.sin(Math.PI * e);
  return out;
}

/**
 * Pick the next preset: weighted by rating, never the current one. `rand` returns 0..1.
 */
export function pickNext(current, rand = Math.random) {
  const options = PRESETS.map((p, i) => i).filter((i) => i !== current);
  const total = options.reduce((s, i) => s + PRESETS[i].rating, 0);
  let r = rand() * total;
  for (const i of options) {
    r -= PRESETS[i].rating;
    if (r < 0) return i;
  }
  return options[options.length - 1];
}
