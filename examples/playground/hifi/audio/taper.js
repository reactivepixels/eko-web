/** Level maths for the A-707's front panel: the volume scale and the loudness contour. */

export const dbToGain = (db) => (db === -Infinity ? 0 : Math.pow(10, db / 20));

/**
 * The volume knob's printed scale, in dB of attenuation at equal angles: infinity, 60, 40,
 * 30, 20, 15, 10, 5, 0. Position runs 0 to 8, one step per printed mark.
 */
export const VOLUME_MARKS = [-Infinity, -60, -40, -30, -20, -15, -10, -5, 0];
export const VOLUME_MAX = VOLUME_MARKS.length - 1;
/** The knob turns 140 degrees either side of top. */
export const VOLUME_SWEEP = 140;

/** Between infinity and -60 the scale fades from this floor, so the bottom is continuous. */
const FLOOR_DB = -90;

export function volumeDb(pos) {
  const p = Math.max(0, Math.min(VOLUME_MAX, pos));
  if (p === 0) return -Infinity;
  if (p === VOLUME_MAX) return 0;
  const i = Math.floor(p);
  const f = p - i;
  const lo = i === 0 ? FLOOR_DB : VOLUME_MARKS[i];
  return lo + (VOLUME_MARKS[i + 1] - lo) * f;
}

export const volumeAngle = (pos) => -VOLUME_SWEEP + (2 * VOLUME_SWEEP * pos) / VOLUME_MAX;

/**
 * Loudness contour: the quieter the setting, the more bass (and a little treble) it adds
 * back, the way the ear loses both at low level. Nothing at full volume.
 */
export function loudnessDb(attenDb) {
  const amount = attenDb === -Infinity ? 1 : Math.max(0, Math.min(1, -attenDb / 40));
  return { low: 10 * amount, high: 4 * amount };
}

/** Balance as a pair of channel gains: centre is unity both sides, full turn mutes one. */
export function balanceGains(balance) {
  const b = Math.max(-1, Math.min(1, balance));
  return { left: b > 0 ? 1 - b : 1, right: b < 0 ? 1 + b : 1 };
}
