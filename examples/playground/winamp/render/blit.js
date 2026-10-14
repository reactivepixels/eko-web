/** Drawing surfaces: a 1x backing canvas per window, blitted from sheets, shown crisp. */
import { S } from "../skin/sprites.js";

/** A 1x backing canvas in skin pixels. */
export function createSurface(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** Draw a named sprite at x, y. */
export function blit(ctx, sheets, name, x, y) {
  const s = S[name];
  ctx.drawImage(sheets[s.sheet], s.x, s.y, s.w, s.h, x, y, s.w, s.h);
}

/** Draw the left part of a sprite, `w` pixels wide (fills and partial bars). */
export function blitPart(ctx, sheets, name, w, x, y) {
  const s = S[name];
  if (w <= 0) return;
  ctx.drawImage(sheets[s.sheet], s.x, s.y, w, s.h, x, y, w, s.h);
}

/**
 * Copy the 1x backing to the visible canvas: integer scale in device pixels, no smoothing,
 * so every skin pixel lands on whole device pixels at any devicePixelRatio.
 */
export function present(backing, view, scale) {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const k = scale * dpr;
  const w = backing.width;
  const h = backing.height;
  if (view.width !== w * k) view.width = w * k;
  if (view.height !== h * k) view.height = h * k;
  view.style.width = `${w * scale}px`;
  view.style.height = `${h * scale}px`;
  const vctx = view.getContext("2d");
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(backing, 0, 0, w * k, h * k);
}
