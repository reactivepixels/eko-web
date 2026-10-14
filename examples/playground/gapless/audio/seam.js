/**
 * Measuring a seam in captured output. Near the seam the built-in material never goes quiet
 * on its own, so a run of near-zero samples there is time the player spent between files.
 * For your own album, any silence the music already has at the seam is subtracted.
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
 * The longest run of silence inside [from, to) (default: strictly inside the music, since
 * leading and trailing silence are the capture's, not the seam's). Returns { start, length }
 * in samples, length 0 if none.
 */
export function findGap(samples, from = contentStart(samples), to = contentEnd(samples)) {
  let best = { start: -1, length: 0 };
  if (from < 0) return best;
  let runStart = -1;
  const end = Math.min(to, samples.length);
  for (let i = Math.max(0, from); i <= end; i++) {
    const quiet = i < end && Math.abs(samples[i]) <= SILENCE;
    if (quiet) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const length = i - runStart;
      if (length >= MIN_GAP && length > best.length) best = { start: runStart, length };
      runStart = -1;
    }
  }
  return best;
}

/** How far either side of the expected seam to look for the player's gap, in seconds. */
export const SEARCH = 0.25;

/**
 * Where the seam sits in a capture and how much silence the player added there.
 *
 * Only a window around the expected seam is searched (`half` seconds after the music
 * starts), so a quiet passage elsewhere can never pass for a gap. `sourceGap` is silence the
 * music itself already has at that spot (a fade-out on your own album, say), in samples at
 * the capture's rate; only silence beyond it counts against the player.
 *
 * `leadIn` is silence at the very start of the music, in seconds: the capture's first sound
 * comes that much later than the clip's start, so the seam does too.
 *
 * `valid` is false when the capture does not look like the round at all (nothing recorded,
 * or far too short), so the page can say "?" instead of a confident, wrong 0.
 */
export function measureSeam(samples, rate, half, sourceGap = 0, leadIn = 0) {
  const start = contentStart(samples);
  const end = contentEnd(samples);
  if (start < 0 || end - start < half * rate * 1.5) {
    return { at: -1, samples: 0, ms: 0, valid: false };
  }
  const expected = start + Math.round((half - leadIn) * rate);
  const reach = Math.round(SEARCH * rate);
  const gap = findGap(samples, expected - reach, expected + reach + sourceGap);
  const added = Math.max(0, gap.length - sourceGap);
  if (gap.length > 0 && added >= MIN_GAP) {
    return { at: gap.start, samples: added, ms: (added / rate) * 1000, valid: true };
  }
  return { at: gap.length > 0 ? gap.start : expected, samples: 0, ms: 0, valid: true };
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
