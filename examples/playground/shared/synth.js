/**
 * Generated music for the Playground: a few warm synth textures rendered sample by sample,
 * seeded so they sound the same on every load. The blind test cuts them into rounds; the
 * visualizer plays them as a continuous set.
 */

/** Small seeded generator, so a round sounds the same on every load and in tests. */
export function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const TAU = Math.PI * 2;

/** A soft, warm partial stack for one held or plucked note. */
function voice(out, rate, f, start, len, amp, { decay = 0, attack = 0.01, bright = 0.35 } = {}) {
  const a = Math.max(1, Math.round(attack * rate));
  const s0 = Math.max(0, Math.round(start * rate));
  const s1 = Math.min(out.length, Math.round((start + len) * rate));
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / rate;
    const env = Math.min(1, (i - s0) / a) * (decay ? Math.exp(-t / decay) : 1);
    const ph = TAU * f * t;
    out[i] +=
      amp *
      env *
      (Math.sin(ph) + bright * Math.sin(2 * ph + 0.3) + bright * 0.4 * Math.sin(3 * ph + 1.1));
  }
}

/** One-pole low-pass, in place. */
function lowpass(x, rate, hz) {
  const k = 1 - Math.exp((-TAU * hz) / rate);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += k * (x[i] - y);
    x[i] = y;
  }
  return x;
}

function noise(length, rand) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Long chords that ring straight through the cut: the classic live-album crossfade. */
function pad(out, rate, { root, rand }) {
  const chords = [
    [0, 7, 12, 16],
    [-3, 4, 9, 12],
    [-7, 0, 5, 9],
  ];
  const dur = out.length / rate;
  chords.forEach((c, k) => {
    const start = (k * dur) / chords.length - 0.6;
    for (const n of c) {
      const f = midi(root + n) * (1 + (rand() - 0.5) * 0.004);
      voice(out, rate, f, Math.max(0, start), dur / chords.length + 1.4, 0.07, {
        attack: 0.5,
        bright: 0.25,
      });
      voice(out, rate, f * 1.003, Math.max(0, start), dur / chords.length + 1.4, 0.05, {
        attack: 0.6,
        bright: 0.2,
      });
    }
  });
  const air = lowpass(noise(out.length, rand), rate, 3000);
  for (let i = 0; i < out.length; i++) out[i] += air[i] * 0.015;
}

/** Sixteenth-note plucks: one lands right on the cut, so a gap clips it. */
function arpeggio(out, rate, { root, bpm, rand }) {
  const step = 60 / bpm / 4;
  const notes = [0, 7, 12, 15, 19, 15, 12, 7];
  const dur = out.length / rate;
  for (let k = 0, t = 0; t < dur; k++, t += step) {
    voice(out, rate, midi(root + 12 + notes[k % notes.length]), t, step * 3, 0.16, {
      decay: 0.18,
      attack: 0.003,
      bright: 0.5,
    });
  }
  voice(out, rate, midi(root - 12), 0, dur, 0.12, { attack: 0.05, bright: 0.15 });
  const shimmer = lowpass(noise(out.length, rand), rate, 6000);
  for (let i = 0; i < out.length; i++) out[i] += shimmer[i] * 0.006;
}

/** The end of one song on a live record: crowd noise, applause and a ringing organ chord. */
function crowd(out, rate, { root, rand }) {
  const roar = lowpass(noise(out.length, rand), rate, 1800);
  for (let i = 0; i < out.length; i++) out[i] += roar[i] * 0.22;
  const claps = Math.round((out.length / rate) * 60);
  for (let c = 0; c < claps; c++) {
    const at = Math.floor(rand() * out.length);
    const amp = 0.05 + rand() * 0.1;
    for (let i = 0; i < 400 && at + i < out.length; i++) {
      out[at + i] += (rand() * 2 - 1) * amp * Math.exp(-i / 70);
    }
  }
  for (const n of [0, 4, 7, 12])
    voice(out, rate, midi(root + n), 0, out.length / rate, 0.045, { attack: 0.3, bright: 0.6 });
}

/** Kick, hat and bass: the cut falls inside a bar, so a gap stumbles the groove. */
function groove(out, rate, { root, bpm, rand }) {
  const beat = 60 / bpm;
  const dur = out.length / rate;
  for (let t = 0; t < dur; t += beat) {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < rate * 0.25 && s0 + i < out.length; i++) {
      const tt = i / rate;
      out[s0 + i] +=
        0.5 * Math.exp(-tt / 0.09) * Math.sin(TAU * (48 + 90 * Math.exp(-tt / 0.03)) * tt);
    }
  }
  for (let t = beat / 2; t < dur; t += beat / 2) {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < rate * 0.05 && s0 + i < out.length; i++) {
      out[s0 + i] += (rand() * 2 - 1) * 0.06 * Math.exp(-i / (rate * 0.012));
    }
  }
  const line = [0, 0, 3, 5, 7, 5, 3, -2];
  for (let k = 0, t = 0; t < dur; k++, t += beat / 2) {
    voice(out, rate, midi(root - 12 + line[k % line.length]), t, beat / 2, 0.14, {
      decay: 0.2,
      attack: 0.004,
      bright: 0.4,
    });
  }
}

/** A slow, beating drone: the plainest possible test, nothing to hide a click behind. */
function drone(out, rate, { root }) {
  const dur = out.length / rate;
  voice(out, rate, midi(root - 12), 0, dur, 0.2, { attack: 0.2, bright: 0.2 });
  voice(out, rate, midi(root - 12) * 1.0025, 0, dur, 0.14, { attack: 0.2, bright: 0.1 });
  voice(out, rate, midi(root - 5), 0, dur, 0.09, { attack: 0.2, bright: 0.3 });
}

export const STYLES = { pad, arpeggio, crowd, groove, drone };

/** Peak-normalize in place to `peak` (about -3 dBFS by default). */
export function normalize(out, peak = 0.707) {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  const g = max > 0 ? peak / max : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/**
 * A continuous 64 second set: a pad opens, an arpeggio comes in over it, a groove takes over,
 * and a crowd closes it out, all at 124 bpm in A. Cut into four tracks at the marks below,
 * it plays as one piece only if the player is gapless.
 */
export const SET_SECONDS = 64;
export const SET_MARKS = [0, 16, 32, 48];
export const SET_TITLES = [
  "EKO - Ember Set I. Glass Dawn",
  "EKO - Ember Set II. Relay",
  "EKO - Ember Set III. Night Bus",
  "EKO - Ember Set IV. Encore",
];

export function renderSet(rate = 44100) {
  const out = new Float32Array(rate * SET_SECONDS);
  const layer = (style, from, to, fadeIn, fadeOut, gain, opts) => {
    const n = Math.round((to - from) * rate);
    const buf = new Float32Array(n);
    STYLES[style](buf, rate, { root: 57, bpm: 124, rand: seeded(from * 31 + 7), ...opts });
    const fi = fadeIn * rate;
    const fo = fadeOut * rate;
    const at = Math.round(from * rate);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, fi ? i / fi : 1, fo ? (n - i) / fo : 1);
      out[at + i] += buf[i] * env * gain;
    }
  };
  layer("drone", 0, 64, 3, 4, 0.5, { root: 45 });
  layer("pad", 0, 26, 4, 6, 1, {});
  layer("arpeggio", 10, 50, 4, 4, 0.9, {});
  layer("groove", 22, 58, 2, 3, 1, { root: 45 });
  layer("crowd", 44, 64, 5, 3, 0.9, {});
  return normalize(out);
}

/** The set as four WAV files that join with no gap. */
export function setFiles(rate = 44100) {
  const set = renderSet(rate);
  return SET_MARKS.map((mark, i) => {
    const from = Math.round(mark * rate);
    const to = Math.round((SET_MARKS[i + 1] ?? SET_SECONDS) * rate);
    return new File([wavBlob([set.subarray(from, to)], rate)], `${SET_TITLES[i]}.wav`, {
      type: "audio/wav",
    });
  });
}

/** Interleave and write 16-bit PCM WAV. `channels` is an array of equal-length Float32Arrays. */
export function wavBlob(channels, rate) {
  const n = channels[0].length;
  const ch = channels.length;
  const bytes = new ArrayBuffer(44 + n * ch * 2);
  const view = new DataView(bytes);
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * ch * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Cut channels at `at` samples into two WAV blobs that join with no gap and no overlap. */
export function splitAt(channels, rate, at) {
  return [
    wavBlob(
      channels.map((c) => c.subarray(0, at)),
      rate,
    ),
    wavBlob(
      channels.map((c) => c.subarray(at)),
      rate,
    ),
  ];
}
