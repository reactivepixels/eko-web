/**
 * The test material. Each round is one continuous piece of music, cut in two at its exact
 * middle: the first file ends mid-note and the second picks up on the very next sample. Any
 * gap between them is the player's, never the music's, and there is no encoder padding to
 * blame because both halves are plain WAV.
 */

export const CLIP_RATE = 44100;
/** Seconds either side of the seam. */
export const HALF = 3;

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

/** Ten rounds: five textures, each twice in a different key and tempo. */
export const ROUNDS = [
  { style: "pad", root: 57, bpm: 90, from: "03 Low Tide", to: "04 Salt Lines", side: "Side A" },
  {
    style: "arpeggio",
    root: 62,
    bpm: 112,
    from: "01 Morning Glass",
    to: "02 Relay",
    side: "Side A",
  },
  {
    style: "crowd",
    root: 55,
    bpm: 100,
    from: "06 Harbour Lights",
    to: "07 Encore",
    side: "Side B, live",
  },
  { style: "groove", root: 45, bpm: 118, from: "02 Night Bus", to: "03 Terminus", side: "Side A" },
  { style: "drone", root: 50, bpm: 60, from: "05 Long Wave", to: "06 Carrier", side: "Side B" },
  {
    style: "arpeggio",
    root: 57,
    bpm: 132,
    from: "08 Mirrorball",
    to: "09 Afterhours",
    side: "Side B",
  },
  {
    style: "pad",
    root: 60,
    bpm: 80,
    from: "04 Salt Lines",
    to: "05 Undertow",
    side: "Side B, live",
  },
  { style: "groove", root: 40, bpm: 96, from: "10 Slow Burn", to: "11 Embers", side: "Side B" },
  {
    style: "crowd",
    root: 52,
    bpm: 100,
    from: "12 Thank You",
    to: "13 One More",
    side: "Side C, live",
  },
  { style: "drone", root: 47, bpm: 60, from: "01 Overture", to: "02 Threshold", side: "Side A" },
];

/** Render a round as one continuous mono signal, 2 x HALF seconds, peak-normalized to -3 dBFS. */
export function renderRound(index, rate = CLIP_RATE) {
  const round = ROUNDS[index % ROUNDS.length];
  const out = new Float32Array(rate * HALF * 2);
  STYLES[round.style](out, rate, { ...round, rand: seeded(index * 977 + 13) });
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.707 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
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
