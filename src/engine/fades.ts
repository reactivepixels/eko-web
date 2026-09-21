/**
 * Short gain ramps that keep transport changes click-free.
 *
 * Cutting a running audio source produces a discontinuity, which is an audible click. A
 * ramp of a few milliseconds removes it without being perceptible as a fade, so this
 * needs no consumer-facing API: it simply always happens.
 */

/** Ten milliseconds: long enough to remove the discontinuity, short enough to feel instant. */
export const DEFAULT_FADE_SECONDS = 0.01;

/**
 * Ramp `param` to `target` over `seconds`, starting at `now`. Pins the current value first
 * so the ramp starts from where the param actually is rather than from an earlier
 * automation point. Returns the AudioContext time the ramp completes.
 */
export function rampTo(param: AudioParam, target: number, now: number, seconds: number): number {
  const end = now + seconds;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, end);
  return end;
}
