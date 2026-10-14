/**
 * The numbers a MilkDrop preset is written against. `bass`, `mid` and `treb` are each band's
 * energy relative to its own recent average, so they sit near 1.0 whatever the volume and
 * jump above it on a hit. The `_att` versions are the same, smoothed. Beats come from bass
 * hits, and the tempo from the spacing between them.
 */

export const BANDS = { bass: [20, 150], mid: [150, 2000], treb: [2000, 11000] };

/** Mean power (0..1) of the analyser bins inside [lo, hi) Hz. */
export function bandEnergy(bytes, sampleRate, fftSize, [lo, hi]) {
  const hz = sampleRate / fftSize;
  const a = Math.max(1, Math.floor(lo / hz));
  const b = Math.min(bytes.length, Math.max(a + 1, Math.ceil(hi / hz)));
  let sum = 0;
  for (let i = a; i < b; i++) {
    const v = bytes[i] / 255;
    sum += v * v;
  }
  return sum / (b - a);
}

export function createAnalysis() {
  return {
    avg: { bass: 0, mid: 0, treb: 0 },
    warm: 0,
    now: { bass: 1, mid: 1, treb: 1 },
    att: { bass: 1, mid: 1, treb: 1 },
    beat: false,
    lastBeat: -1,
    intervals: [],
    bpm: 0,
  };
}

const FLOOR = 1e-4;

/**
 * Advance by `dt` seconds with this frame's band energies, at clock time `time`.
 * @param {{ bass: number, mid: number, treb: number }} e
 */
export function stepAnalysis(st, e, dt, time) {
  const slow = 1 - Math.exp(-dt / 2.5);
  const fast = 1 - Math.exp(-dt / 0.3);
  const prevBass = st.now.bass;
  // The average rises quickly and falls slowly: a fade-in should not read as a 3x hit, and
  // silence should hand back a clean slate rather than hold the bands at zero.
  const rise = 1 - Math.exp(-dt / 0.6);
  // For half a second after silence the average simply follows the signal, so music
  // starting (or fading in) begins at 1 instead of reading as a huge hit.
  if (e.bass < FLOOR && e.mid < FLOOR && e.treb < FLOOR) st.warm = 0.5;
  else st.warm = Math.max(0, (st.warm ?? 0) - dt);
  for (const k of ["bass", "mid", "treb"]) {
    if (st.warm > 0 || st.avg[k] < FLOOR || e[k] < FLOOR) st.avg[k] = e[k];
    else st.avg[k] += (e[k] - st.avg[k]) * (e[k] > st.avg[k] * 1.5 ? rise : slow);
    // Near silence the average is meaningless: rest at 1 rather than amplify the hiss.
    st.now[k] = st.avg[k] < FLOOR ? 1 : Math.min(3, e[k] / st.avg[k]);
    st.att[k] += (st.now[k] - st.att[k]) * fast;
  }
  const rising = st.now.bass > prevBass;
  st.beat = st.now.bass > 1.35 && rising && time - st.lastBeat > 0.28 && st.avg.bass >= FLOOR;
  if (st.beat) {
    if (st.lastBeat >= 0) {
      const gap = time - st.lastBeat;
      if (gap < 2) {
        st.intervals.push(gap);
        if (st.intervals.length > 12) st.intervals.shift();
        st.bpm = tempo(st.intervals);
      }
    }
    st.lastBeat = time;
  }
  return st;
}

/** Median beat spacing as bpm, folded into 80..160 the way a DJ counts it. */
export function tempo(intervals) {
  if (intervals.length < 3) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  let bpm = 60 / sorted[Math.floor(sorted.length / 2)];
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}
