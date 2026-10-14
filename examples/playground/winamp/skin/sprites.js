/**
 * Where every sprite lives in its sheet (S), how big each sheet is (SHEETS), and where things
 * are drawn inside each window (L). Sheet names follow Winamp 2.x's skin bitmaps, so a .wsz
 * loader can fill the same sheets later without touching any window code.
 *
 * Sheets are packed top to bottom in the order listed. A pressed variant ("...Down") always
 * sits directly under its normal sprite, at the same size.
 */

/** Characters in the TEXT sheet, five pixels apart. */
export const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .:-()*/'&_[]!?+,\"#$%@=<>";
export const GLYPH_W = 5;
export const GLYPH_H = 6;
/** TEXT sheet rows, one per colour. */
export const TEXT_ROWS = { green: 0, white: 1, dim: 2 };

/** NUMBERS sheet: 9x13 cells for 0 to 9, then a blank (all ghost segments), then a minus. */
export const DIGIT_W = 9;
export const DIGIT_H = 13;
export const DIGIT_BLANK = 10;
export const DIGIT_MINUS = 11;

/** VOLUME sheet: one 68x11 wedge per level, quietest first. */
export const VOLUME_FRAMES = 28;

const withDown = (name, w, h) => [
  [name, w, h],
  [`${name}Down`, w, h],
];

const DEFS = {
  MAIN: [["mainBg", 275, 116]],
  TITLEBAR: [["titleActive", 275, 14], ["titleInactive", 275, 14], ...withDown("closeBtn", 9, 9)],
  CBUTTONS: [
    ...withDown("btnPrev", 23, 18),
    ...withDown("btnPlay", 23, 18),
    ...withDown("btnPause", 23, 18),
    ...withDown("btnStop", 23, 18),
    ...withDown("btnNext", 22, 18),
    ...withDown("btnEject", 22, 16),
  ],
  POSBAR: [...withDown("posThumb", 29, 10), ["posFill", 246, 2]],
  VOLUME: [
    ...Array.from({ length: VOLUME_FRAMES }, (_, i) => [`vol${i}`, 68, 11]),
    ...withDown("volThumb", 14, 11),
  ],
  BALANCE: [["balBg", 38, 11], ...withDown("balThumb", 14, 11)],
  SHUFREP: [
    ["shuffleOff", 46, 15],
    ["shuffleOn", 46, 15],
    ["repeatOff", 28, 15],
    ["repeatOn", 28, 15],
    ["eqToggleOff", 23, 12],
    ["eqToggleOn", 23, 12],
    ["plToggleOff", 23, 12],
    ["plToggleOn", 23, 12],
  ],
  MONOSTER: [
    ["mono", 25, 10],
    ["monoLit", 25, 10],
    ["stereo", 30, 10],
    ["stereoLit", 30, 10],
  ],
  PLAYPAUS: [
    ["playInd", 11, 9],
    ["pauseInd", 11, 9],
    ["stopInd", 11, 9],
  ],
  EQMAIN: [
    ["eqBg", 275, 116],
    ["eqTitleActive", 275, 14],
    ["eqTitleInactive", 275, 14],
    ...withDown("eqSliderThumb", 12, 11),
    ["eqOnOff", 26, 12],
    ["eqOnOn", 26, 12],
    ["eqAutoOff", 32, 12],
    ["eqAutoOn", 32, 12],
    ...withDown("presets", 44, 12),
  ],
  PLEDIT: [
    ["plBg", 275, 145],
    ["plTitleActive", 275, 20],
    ["plTitleInactive", 275, 20],
    ...withDown("plAdd", 27, 18),
    ...withDown("plRem", 27, 18),
    ...withDown("plSel", 27, 18),
    ...withDown("plMisc", 27, 18),
    ...withDown("plList", 27, 18),
    ["plScrollThumb", 8, 18],
  ],
};

/** @type {Record<string, {w: number, h: number}>} */
export const SHEETS = {
  TEXT: { w: GLYPHS.length * GLYPH_W, h: GLYPH_H * 3 },
  NUMBERS: { w: DIGIT_W * 12, h: DIGIT_H },
};

/** @type {Record<string, {sheet: string, x: number, y: number, w: number, h: number}>} */
export const S = {};

for (const [sheet, list] of Object.entries(DEFS)) {
  let y = 0;
  let w = 0;
  for (const [name, sw, sh] of list) {
    S[name] = { sheet, x: 0, y, w: sw, h: sh };
    y += sh;
    w = Math.max(w, sw);
  }
  SHEETS[sheet] = { w, h: y };
}

/** Rects inside each window, in that window's own skin pixels. */
export const L = {
  // main window
  playInd: { x: 24, y: 28, w: 11, h: 9 },
  time: { x: 48, y: 26, w: 51, h: 13 },
  vis: { x: 24, y: 43, w: 76, h: 16 },
  marquee: { x: 110, y: 24, w: 154, h: 12 },
  kbps: { x: 110, y: 42 },
  khz: { x: 154, y: 42 },
  mono: { x: 209, y: 40, w: 25, h: 10 },
  stereo: { x: 236, y: 40, w: 30, h: 10 },
  volume: { x: 107, y: 58, w: 68, h: 11 },
  balance: { x: 177, y: 58, w: 38, h: 11 },
  eqToggle: { x: 219, y: 58, w: 23, h: 12 },
  plToggle: { x: 242, y: 58, w: 23, h: 12 },
  posbar: { x: 16, y: 72, w: 248, h: 10 },
  prev: { x: 16, y: 88, w: 23, h: 18 },
  play: { x: 39, y: 88, w: 23, h: 18 },
  pause: { x: 62, y: 88, w: 23, h: 18 },
  stop: { x: 85, y: 88, w: 23, h: 18 },
  next: { x: 108, y: 88, w: 22, h: 18 },
  eject: { x: 136, y: 89, w: 22, h: 16 },
  shuffle: { x: 164, y: 89, w: 46, h: 15 },
  repeat: { x: 211, y: 89, w: 28, h: 15 },
  close: { x: 264, y: 3, w: 9, h: 9 },
  // equalizer
  eqOn: { x: 14, y: 18, w: 26, h: 12 },
  eqAuto: { x: 40, y: 18, w: 32, h: 12 },
  presets: { x: 217, y: 18, w: 44, h: 12 },
  eqGraph: { x: 86, y: 17, w: 113, h: 19 },
  preamp: { x: 21, y: 38, w: 14, h: 63 },
  band0: { x: 78, y: 38, w: 14, h: 63 },
  bandStep: { x: 18 },
  // playlist
  plList: { x: 12, y: 20, w: 243, h: 87 },
  plScroll: { x: 260, y: 20, w: 10, h: 87 },
  plAdd: { x: 11, y: 117, w: 27, h: 18 },
  plRem: { x: 40, y: 117, w: 27, h: 18 },
  plSel: { x: 69, y: 117, w: 27, h: 18 },
  plMisc: { x: 98, y: 117, w: 27, h: 18 },
  plListBtn: { x: 240, y: 117, w: 27, h: 18 },
  plInfo: { x: 130, y: 113, w: 98, h: 11 },
  plTime: { x: 183, y: 127, w: 45, h: 10 },
};
