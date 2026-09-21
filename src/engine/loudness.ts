/**
 * Loudness measurement + normalization gain.
 *
 * Integrated loudness is measured per ITU-R BS.1770 "K-weighting" (the basis of LUFS and
 * ReplayGain 2.0): a high-shelf + a high-pass biquad approximating the ear's frequency
 * response, then mean-square energy. The K-weighting filters are realised with standard
 * RBJ ("Audio EQ Cookbook") biquads so the coefficients are correct at ANY sample rate,
 * not just the 48 kHz the spec tabulates.
 *
 * NOTE: this measures *loudness* for the purpose of evening out track-to-track volume.
 * It does NOT change fidelity. See the project README. We use simple (ungated) integrated
 * loudness; gating + true-peak oversampling can be added later without changing callers.
 */

/** A normalized biquad (a0 == 1). */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// ── BS.1770-4 K-weighting filter parameters ───────────────────────────────────
const SHELF_F0 = 1681.974450955533;
const SHELF_Q = 0.7071752369554196;
const SHELF_GAIN_DB = 3.999843853973347;
const HPF_F0 = 38.13547087602444;
const HPF_Q = 0.5003270373238773;

// ── RBJ biquad designers ──────────────────────────────────────────────────────

function highShelf(f0: number, q: number, gainDb: number, fs: number): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const ss = 2 * Math.sqrt(a) * alpha;

  const b0 = a * (a + 1 + (a - 1) * cw + ss);
  const b1 = -2 * a * (a - 1 + (a + 1) * cw);
  const b2 = a * (a + 1 + (a - 1) * cw - ss);
  const a0 = a + 1 - (a - 1) * cw + ss;
  const a1 = 2 * (a - 1 - (a + 1) * cw);
  const a2 = a + 1 - (a - 1) * cw - ss;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highPass(f0: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = (1 + cw) / 2;
  const b1 = -(1 + cw);
  const b2 = (1 + cw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Apply a biquad (Direct Form I) over a channel, returning a new array. */
function filter(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const xn = x[n]!;
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[n] = yn;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
  }
  return y;
}

/** K-weight a channel: high-shelf then high-pass (BS.1770 stages 1 & 2). */
function kWeight(channel: Float32Array, fs: number): Float32Array {
  const stage1 = filter(channel, highShelf(SHELF_F0, SHELF_Q, SHELF_GAIN_DB, fs));
  return filter(stage1, highPass(HPF_F0, HPF_Q, fs));
}

// ── Public measurement API ────────────────────────────────────────────────────

/**
 * Integrated loudness in LUFS (ungated) for one or more channels at `sampleRate`.
 * Returns `-Infinity` for digital silence.
 */
export function measureLoudnessLufs(channels: Float32Array[], sampleRate: number): number {
  if (channels.length === 0 || channels[0]!.length === 0) return -Infinity;
  // Sum of channel mean-squares with BS.1770 channel weights (1.0 for L/R/C).
  let weightedMeanSquareSum = 0;
  for (const ch of channels) {
    const w = kWeight(ch, sampleRate);
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i]! * w[i]!;
    weightedMeanSquareSum += sum / w.length; // channel weight = 1.0
  }
  if (weightedMeanSquareSum <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(weightedMeanSquareSum);
}

/** Maximum absolute sample value across channels (sample peak, in [0, ~1+]). */
export function samplePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// ── Gain math ─────────────────────────────────────────────────────────────────

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  return 20 * Math.log10(linear);
}

/**
 * The linear gain to reach `targetLufs`, CLAMPED so the loudest sample can't exceed full
 * scale (`peak * gain <= 1`), so normalization never introduces clipping. Silence (or a
 * missing measurement) returns unity.
 */
export function computeNormalizationGain(
  loudnessLufs: number,
  targetLufs: number,
  peak: number,
): number {
  if (!Number.isFinite(loudnessLufs)) return 1;
  let gain = dbToLinear(targetLufs - loudnessLufs);
  if (peak > 0) gain = Math.min(gain, 1 / peak);
  return gain;
}
