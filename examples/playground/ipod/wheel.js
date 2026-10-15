/**
 * Click wheel maths. Angles are in degrees, 0 at the top and growing clockwise, so turning
 * the wheel clockwise moves a menu down and the volume up, as on the real thing.
 */

/** Degrees of turn per step: about 24 steps a full revolution, like the 5th generation. */
export const STEP_DEG = 15;

/** Radius of the centre button, in wheel units (the wheel is 186 across). */
export const HUB_RADIUS = 40;

/**
 * Whether a point is on the turning ring rather than over the centre button. Near the
 * centre a pixel of movement swings the angle by up to 180 degrees, so those points must
 * never be read as turn.
 */
export function onRing(x, y, cx, cy, inner = HUB_RADIUS) {
  return Math.hypot(x - cx, y - cy) > inner;
}

/** Angle of a point around the centre, 0 at the top, clockwise, in [0, 360). */
export function angleOf(x, y, cx, cy) {
  const a = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
  return (a + 360) % 360;
}

/** The shortest signed turn from `a` to `b`, in (-180, 180]. */
export function angleDelta(a, b) {
  let d = (((b - a) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Turns a stream of angles into whole steps, carrying the remainder, so a slow drag and a
 * fast spin both land on the same item for the same amount of turn.
 */
export function createTracker(step = STEP_DEG) {
  let last = null;
  let carry = 0;
  let travelled = 0;
  return {
    start(angle) {
      last = angle;
      carry = 0;
      travelled = 0;
    },
    /** Feed the next angle; returns the whole steps it completed (negative is anticlockwise). */
    move(angle) {
      if (last === null) {
        last = angle;
        return 0;
      }
      const d = angleDelta(last, angle);
      last = angle;
      travelled += Math.abs(d);
      carry += d;
      const steps = Math.trunc(carry / step);
      carry -= steps * step;
      return steps;
    },
    /** Total degrees turned since start, either way: tells a turn from a press. */
    get travelled() {
      return travelled;
    },
    end() {
      last = null;
    },
  };
}

/**
 * Which part of the wheel a point is on: the centre button, one of the four pressable
 * quarters (MENU at the top, then next, play/pause and previous clockwise), or nothing.
 * Radii are in the same units as the point.
 */
export function zoneOf(x, y, cx, cy, inner, outer) {
  const r = Math.hypot(x - cx, y - cy);
  if (r <= inner) return "center";
  if (r > outer) return null;
  const a = angleOf(x, y, cx, cy);
  if (a >= 315 || a < 45) return "menu";
  if (a < 135) return "next";
  if (a < 225) return "play";
  return "prev";
}
