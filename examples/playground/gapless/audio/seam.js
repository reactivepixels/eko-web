/**
 * Measuring a seam in captured output. The material never goes quiet on its own, so any run
 * of near-zero samples after the music starts is time the player spent between files.
 */

/** Below this a sample counts as silence (about -80 dBFS). */
export const SILENCE = 1e-4;
/** Runs shorter than this are a waveform crossing zero, not a gap. */
export const MIN_GAP = 24;

/** Index of the first sample that is not silence, or -1. */
export function contentStart(samples) {
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > SILENCE) return i;
  return -1;
}

/** Index just past the last sample that is not silence, or -1. */
export function contentEnd(samples) {
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]) > SILENCE) return i + 1;
  return -1;
}

/**
 * The longest run of silence strictly inside the music (leading and trailing silence are the
 * capture's, not the seam's). Returns { start, length } in samples, length 0 if none.
 */
export function findGap(samples) {
  const from = contentStart(samples);
  const to = contentEnd(samples);
  let best = { start: -1, length: 0 };
  if (from < 0) return best;
  let runStart = -1;
  for (let i = from; i < to; i++) {
    if (Math.abs(samples[i]) <= SILENCE) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const length = i - runStart;
      if (length >= MIN_GAP && length > best.length) best = { start: runStart, length };
      runStart = -1;
    }
  }
  return best;
}

/**
 * Where the seam sits in a capture and how wide it is. With a gap, it is the gap. Without
 * one, it is where the second file began: `half` seconds after the music started.
 */
export function measureSeam(samples, rate, half) {
  const gap = findGap(samples);
  if (gap.length > 0) return { at: gap.start, samples: gap.length, ms: (gap.length / rate) * 1000 };
  const start = contentStart(samples);
  return { at: start < 0 ? -1 : start + Math.round(half * rate), samples: 0, ms: 0 };
}

/** Peak magnitude per column over a window, for the dot-matrix lanes. */
export function columns(samples, from, to, count) {
  const out = new Float32Array(count);
  const span = (to - from) / count;
  for (let c = 0; c < count; c++) {
    const a = Math.max(0, Math.floor(from + c * span));
    const b = Math.min(samples.length, Math.floor(from + (c + 1) * span));
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(samples[i]));
    out[c] = peak;
  }
  return out;
}

export const formatSamples = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
