/** Bitmap text from the TEXT sheet, and the LCD digits from the NUMBERS sheet. */
import {
  DIGIT_H,
  DIGIT_MINUS,
  DIGIT_W,
  GLYPH_H,
  GLYPH_W,
  GLYPHS,
  TEXT_ROWS,
} from "../skin/sprites.js";

export { GLYPHS, GLYPH_H, GLYPH_W };

const SPACE = GLYPHS.indexOf(" ");

/** Index into GLYPHS. Lowercase folds to caps; anything missing renders as a space. */
export function glyphIndex(ch) {
  const i = GLYPHS.indexOf(ch.toUpperCase());
  return i < 0 ? SPACE : i;
}

export const textWidth = (s) => s.length * GLYPH_W;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Record<string, CanvasImageSource>} sheets
 * @param {string} s
 * @param {"green" | "white" | "dim"} color
 */
export function drawText(ctx, sheets, s, x, y, color = "green") {
  const sy = TEXT_ROWS[color] * GLYPH_H;
  for (let i = 0; i < s.length; i++) {
    const sx = glyphIndex(s[i]) * GLYPH_W;
    ctx.drawImage(sheets.TEXT, sx, sy, GLYPH_W, GLYPH_H, x + i * GLYPH_W, y, GLYPH_W, GLYPH_H);
  }
}

/** One NUMBERS cell: 0 to 9, DIGIT_BLANK or DIGIT_MINUS. */
export function drawDigit(ctx, sheets, cell, x, y) {
  ctx.drawImage(sheets.NUMBERS, cell * DIGIT_W, 0, DIGIT_W, DIGIT_H, x, y, DIGIT_W, DIGIT_H);
}

/**
 * "mm:ss" on the LCD, Winamp style: digits at x, x+12, x+30, x+42 (the colon is part of the
 * background), and a minus to the left when showing remaining time.
 */
export function drawTime(ctx, sheets, seconds, x, y, negative = false) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.min(99, Math.floor(total / 60));
  const s = total % 60;
  if (negative) drawDigit(ctx, sheets, DIGIT_MINUS, x - 11, y);
  drawDigit(ctx, sheets, Math.floor(m / 10), x, y);
  drawDigit(ctx, sheets, m % 10, x + 12, y);
  drawDigit(ctx, sheets, Math.floor(s / 10), x + 30, y);
  drawDigit(ctx, sheets, s % 10, x + 42, y);
}

/** "m:ss", as the playlist and marquee show it. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
