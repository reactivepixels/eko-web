/**
 * Cassette mechanics. The whole queue is one side of tape running at 4.76 cm/s past the
 * head, so each pack's radius follows the area of tape on it, and a hub turns faster the
 * emptier its spool: the reason a real deck's counter is not a clock.
 */

export const HUB_MM = 11;
export const FULL_MM = 24;
export const SPEED_MM_S = 47.6;
/** Counter digits per turn of the take-up reel. */
export const COUNTER_RATIO = 0.5;

/**
 * @param {number} elapsed seconds into the side
 * @param {number} total seconds on the side
 */
export function tapeGeometry(elapsed, total) {
  if (!(total > 0)) {
    return { takeup: HUB_MM, supply: HUB_MM, takeupTurns: 0, supplyTurns: 0 };
  }
  const area = FULL_MM * FULL_MM - HUB_MM * HUB_MM;
  // Tape thickness that makes this side exactly fill one spool.
  const thickness = (Math.PI * area) / (SPEED_MM_S * total);
  const wound = SPEED_MM_S * Math.max(0, Math.min(total, elapsed));
  const takeup = Math.sqrt(HUB_MM * HUB_MM + (wound * thickness) / Math.PI);
  const supply = Math.sqrt(
    Math.max(HUB_MM * HUB_MM, FULL_MM * FULL_MM - (wound * thickness) / Math.PI),
  );
  return {
    takeup,
    supply,
    takeupTurns: (takeup - HUB_MM) / thickness,
    supplyTurns: (FULL_MM - supply) / thickness,
  };
}

/** The counter reading, wrapped at 1000, from take-up turns since the last reset. */
export function counterValue(turns, resetAt = 0) {
  const v = (turns - resetAt) * COUNTER_RATIO;
  return ((v % 1000) + 1000) % 1000;
}

/**
 * Drum positions for a mechanical 3-digit counter. The units drum turns continuously; each
 * higher drum only moves while the one below rolls from 9 to 0, like the real thing.
 * Returns [hundreds, tens, units], each 0 to 10 (10 shows as 0 again).
 */
export function counterDrums(value) {
  const units = value % 10;
  const carry1 = units > 9 ? units - 9 : 0;
  const tensBase = Math.floor(value / 10) % 10;
  const tens = tensBase + carry1;
  const carry2 = tensBase === 9 ? carry1 : 0;
  const hundreds = (Math.floor(value / 100) % 10) + carry2;
  return [hundreds, tens, units];
}
