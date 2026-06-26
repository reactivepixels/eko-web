/**
 * Gapless scheduling math — pure functions so the timing is unit-testable without the
 * Web Audio clock.
 *
 * A buffer source that started at AudioContext time `startCtxTime`, playing a buffer of
 * `duration` seconds from `startOffset`, reaches its natural end at `trackEndTime`. The
 * next track's source is scheduled with `source.start(trackEndTime)` so it begins on the
 * exact sample the previous one ends — zero gap, no overlap.
 */

/** AudioContext time at which the current track ends (its natural-end boundary). */
export function trackEndTime(startCtxTime: number, duration: number, startOffset: number): number {
  return startCtxTime + Math.max(0, duration - startOffset);
}

/** Seconds of playback left for a track ending at `endCtxTime`, observed at `now`. */
export function remaining(endCtxTime: number, now: number): number {
  return Math.max(0, endCtxTime - now);
}

/**
 * Elapsed playback position within a track, clamped to [0, duration].
 * `startOffset` is where the source began; `now - startCtxTime` is how long it's run.
 */
export function elapsed(
  startCtxTime: number,
  startOffset: number,
  duration: number,
  now: number,
): number {
  return Math.max(0, Math.min(startOffset + (now - startCtxTime), duration));
}
