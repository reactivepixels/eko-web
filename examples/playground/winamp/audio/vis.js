/** Pure mapping from analyser data to Winamp's 19-bar spectrum and 76 px oscilloscope. */

export const BAR_COUNT = 19;
export const VIS_HEIGHT = 16;
export const SCOPE_WIDTH = 76;
const LOW_HZ = 60;
const HIGH_HZ = 16000;

/** Inclusive analyser-bin ranges per bar, log spaced. Low bars may share a bin. */
export function barRanges(sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2 - 1;
  const ranges = [];
  let prevEnd = 1;
  for (let i = 0; i < BAR_COUNT; i++) {
    const f0 = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BAR_COUNT);
    const f1 = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, (i + 1) / BAR_COUNT);
    const a = Math.min(maxBin, Math.max(1, Math.floor(f0 / binHz), prevEnd));
    const b = Math.min(maxBin, Math.max(a, Math.ceil(f1 / binHz) - 1));
    ranges.push([a, b]);
    prevEnd = b;
  }
  return ranges;
}

/** Peak of each bar's bins, scaled to 0..VIS_HEIGHT. */
export function binsToBars(bins, ranges, out) {
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    let max = 0;
    for (let k = a; k <= b; k++) if (bins[k] > max) max = bins[k];
    out[i] = Math.round((max / 255) * VIS_HEIGHT);
  }
  return out;
}

const HOLD_SEC = 0.5;
const GRAVITY = 40;

/** Winamp's falling peak dots: hold, then accelerate down until they meet the bar. */
export function createPeaks() {
  const peaks = new Float32Array(BAR_COUNT);
  const held = new Float32Array(BAR_COUNT);
  const speed = new Float32Array(BAR_COUNT);
  return {
    update(bars, dt) {
      for (let i = 0; i < BAR_COUNT; i++) {
        if (bars[i] >= peaks[i]) {
          peaks[i] = bars[i];
          held[i] = 0;
          speed[i] = 0;
        } else if ((held[i] += dt) > HOLD_SEC) {
          speed[i] += GRAVITY * dt;
          peaks[i] = Math.max(bars[i], peaks[i] - speed[i] * dt);
        }
      }
      return peaks;
    },
  };
}

/** Byte time-domain samples down to one y (0..15) per scope column. */
export function scopePoints(samples, out) {
  const step = samples.length / out.length;
  for (let x = 0; x < out.length; x++) {
    const v = samples[Math.floor(x * step)];
    out[x] = Math.max(0, Math.min(15, Math.round(((v - 128) / 128) * 8 + 8)));
  }
  return out;
}
