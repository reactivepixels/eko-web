/**
 * The meters: VU needles with real ballistics, and the G-110's 10-band LED ladder. Pure
 * maths over analyser data, so the page only has to read the analysers and draw.
 */

/**
 * 0 VU sits at -24 dBFS RMS of the amp's output: normalized music at the volume knob's
 * usual -10 dB swings the needles around the red.
 */
export const VU_REF_DBFS = -24;

const lin = (db) => Math.pow(10, db / 20);
const L0 = lin(-20);
const L3 = lin(3);

/** Needle angle in degrees for a VU reading: -20 at -38, +3 at +38, on a linear-voltage scale. */
export function vuAngle(vu) {
  const v = Math.max(-40, Math.min(3.6, vu));
  return -38 + (76 * (lin(v) - L0)) / (L3 - L0);
}

export function rmsDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function peakDb(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export const REST_ANGLE = vuAngle(-40);

export const createNeedle = () => ({ angle: REST_ANGLE, velocity: 0 });

/**
 * A damped spring standing in for the meter movement: about 300 ms to settle, with the
 * slight overshoot a real VU has. The pins stop it at either end of the scale.
 */
export function stepNeedle(needle, target, dt) {
  const k = 140;
  const d = 17;
  const acc = (target - needle.angle) * k - needle.velocity * d;
  needle.velocity += acc * dt;
  needle.angle += needle.velocity * dt;
  if (needle.angle < -40) {
    needle.angle = -40;
    needle.velocity = Math.abs(needle.velocity) * 0.2;
  } else if (needle.angle > 40) {
    needle.angle = 40;
    needle.velocity = -Math.abs(needle.velocity) * 0.2;
  }
  return needle;
}

/** The G-110's bands, the same ten centres as its faders. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const BAND_LABELS = ["31", "62", "125", "250", "500", "1K", "2K", "4K", "8K", "16K"];
export const LADDER_ROWS = 14;

/** Each band reaches halfway (geometrically) to its neighbours. */
export function bandEdges(centers = BANDS) {
  return centers.map((c, i) => {
    const lo = i === 0 ? c / Math.SQRT2 : Math.sqrt(centers[i - 1] * c);
    const hi =
      i === centers.length - 1 ? Math.min(c * Math.SQRT2, 20000) : Math.sqrt(c * centers[i + 1]);
    return [lo, hi];
  });
}

/** FFT bin ranges for each band, at least one bin wide even where bins are coarse. */
export function bandBins(edges, sampleRate, fftSize) {
  const hz = sampleRate / fftSize;
  const last = fftSize / 2 - 1;
  return edges.map(([lo, hi]) => {
    const start = Math.min(last, Math.max(1, Math.round(lo / hz)));
    const end = Math.min(last, Math.max(start, Math.round(hi / hz) - 1));
    return [start, end];
  });
}

/** Ladder floor and ceiling in dB, as read from getFloatFrequencyData. */
export const LADDER_FLOOR_DB = -78;
export const LADDER_TOP_DB = -18;

/** Loudest bin in each band, mapped to 0..1 of the ladder. */
export function bandLevels(dbData, bins, out = new Float32Array(bins.length)) {
  for (let b = 0; b < bins.length; b++) {
    const [start, end] = bins[b];
    let max = -Infinity;
    for (let i = start; i <= end; i++) if (dbData[i] > max) max = dbData[i];
    out[b] = Math.max(0, Math.min(1, (max - LADDER_FLOOR_DB) / (LADDER_TOP_DB - LADDER_FLOOR_DB)));
  }
  return out;
}

export function createLadder(n = BANDS.length) {
  return {
    levels: new Float32Array(n),
    peaks: new Float32Array(n),
    hold: new Float32Array(n),
  };
}

/** Fast attack, slower fall, and a peak that holds half a second before it drops. */
export function stepLadder(ladder, targets, dt) {
  const { levels, peaks, hold } = ladder;
  for (let c = 0; c < levels.length; c++) {
    const t = targets[c];
    const rate = t > levels[c] ? Math.min(1, dt * 30) : Math.min(1, dt * 6);
    levels[c] += (t - levels[c]) * rate;
    if (levels[c] >= peaks[c]) {
      peaks[c] = levels[c];
      hold[c] = 0.5;
    } else if ((hold[c] -= dt) <= 0) {
      peaks[c] = Math.max(levels[c], peaks[c] - dt * 0.9);
    }
  }
  return ladder;
}
