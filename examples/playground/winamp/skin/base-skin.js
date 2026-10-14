/**
 * The EKO-AMP base skin, painted in code into Winamp-shaped sprite sheets. Nothing here knows
 * about state: it only paints sprites. The palette carries the colours Winamp skins keep in
 * viscolor.txt and pledit.txt, for the parts windows fill at runtime.
 */
import {
  DIGIT_H,
  DIGIT_W,
  GLYPH_H,
  GLYPH_W,
  GLYPHS,
  S,
  SHEETS,
  TEXT_ROWS,
  VOLUME_FRAMES,
} from "./sprites.js";

/* ---------- fonts ---------- */

/** 4x5 glyphs for the TEXT sheet and titlebars, one string per row, "#" lit. */
const FONT = {
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  B: ["###.", "#..#", "###.", "#..#", "###."],
  C: [".###", "#...", "#...", "#...", ".###"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
  E: ["####", "#...", "###.", "#...", "####"],
  F: ["####", "#...", "###.", "#...", "#..."],
  G: [".###", "#...", "#.##", "#..#", ".###"],
  H: ["#..#", "#..#", "####", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."],
  J: ["..##", "...#", "...#", "#..#", ".##."],
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#...", "#...", "#...", "#...", "####"],
  M: ["#..#", "####", "####", "#..#", "#..#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "###.", "#...", "#..."],
  Q: [".##.", "#..#", "#..#", "#.#.", ".#.#"],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  T: ["###.", ".#..", ".#..", ".#..", ".#.."],
  U: ["#..#", "#..#", "#..#", "#..#", ".##."],
  V: ["#..#", "#..#", "#..#", ".##.", ".##."],
  W: ["#..#", "#..#", "####", "####", "#..#"],
  X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
  Y: ["#.#.", "#.#.", ".#..", ".#..", ".#.."],
  Z: ["####", "..#.", ".#..", "#...", "####"],
  0: [".##.", "#.##", "##.#", "#..#", ".##."],
  1: [".#..", "##..", ".#..", ".#..", "###."],
  2: ["###.", "...#", ".##.", "#...", "####"],
  3: ["###.", "...#", ".##.", "...#", "###."],
  4: ["#..#", "#..#", "####", "...#", "...#"],
  5: ["####", "#...", "###.", "...#", "###."],
  6: [".##.", "#...", "###.", "#..#", ".##."],
  7: ["####", "...#", "..#.", ".#..", ".#.."],
  8: [".##.", "#..#", ".##.", "#..#", ".##."],
  9: [".##.", "#..#", ".###", "...#", ".##."],
  " ": ["....", "....", "....", "....", "...."],
  ".": ["....", "....", "....", "....", ".#.."],
  ":": ["....", ".#..", "....", ".#..", "...."],
  "-": ["....", "....", "###.", "....", "...."],
  "(": ["..#.", ".#..", ".#..", ".#..", "..#."],
  ")": [".#..", "..#.", "..#.", "..#.", ".#.."],
  "*": ["....", "#.#.", ".#..", "#.#.", "...."],
  "/": ["...#", "..#.", ".#..", ".#..", "#..."],
  "'": [".#..", ".#..", "....", "....", "...."],
  "&": [".#..", "#.#.", ".#..", "#.#.", ".#.#"],
  _: ["....", "....", "....", "....", "####"],
  "[": [".##.", ".#..", ".#..", ".#..", ".##."],
  "]": [".##.", "..#.", "..#.", "..#.", ".##."],
  "!": [".#..", ".#..", ".#..", "....", ".#.."],
  "?": ["###.", "...#", ".##.", "....", ".#.."],
  "+": ["....", ".#..", "###.", ".#..", "...."],
  ",": ["....", "....", "....", ".#..", "#..."],
  '"': ["#.#.", "#.#.", "....", "....", "...."],
  "#": ["#.#.", "####", "#.#.", "####", "#.#."],
  $: [".###", "##..", ".##.", "..##", "###."],
  "%": ["#..#", "..#.", ".#..", "#...", "#..#"],
  "@": [".##.", "#.##", "#.##", "#...", ".##."],
  "=": ["....", "###.", "....", "###.", "...."],
  "<": ["..#.", ".#..", "#...", ".#..", "..#."],
  ">": ["#...", ".#..", "..#.", ".#..", "#..."],
};

/** 3x5 legends printed on the skin (KBPS, SHUFFLE, PRESETS...), plus three wide letters. */
const F3 = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101110100110101",
  L: "100100100100111",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101110011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  0: "111101101101111",
  1: "010110010010111",
  2: "110001010100111",
  3: "110001010001110",
  4: "101101111001001",
  5: "111100110001110",
  6: "011100111101111",
  7: "111001010010010",
  8: "111101111101111",
  9: "111101111001110",
  "+": "000010111010000",
  "-": "000000111000000",
  ".": "000000000000010",
  "/": "001001010100100",
  ":": "000010000010000",
  " ": "000000000000000",
};
const F5 = {
  M: "1000111011101011000110001",
  W: "1000110001101011101110001",
  N: "1000111001101011001110001",
};

/* ---------- palette ---------- */

const lerpC = (a, b, f) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
const ramp3 = (f, lo, mid, hi) => (f < 0.5 ? lerpC(lo, mid, f * 2) : lerpC(mid, hi, (f - 0.5) * 2));

export const PALETTE = {
  /** Spectrum rows, top (loudest) to bottom, as in Winamp's viscolor.txt. */
  vis: [
    [239, 49, 16],
    [206, 41, 16],
    [214, 90, 0],
    [214, 102, 0],
    [214, 115, 0],
    [198, 123, 8],
    [222, 165, 24],
    [214, 181, 33],
    [189, 222, 41],
    [148, 222, 33],
    [41, 206, 16],
    [50, 190, 16],
    [57, 181, 16],
    [49, 156, 8],
    [41, 148, 0],
    [24, 132, 8],
  ].map((c) => `rgb(${c.join(",")})`),
  peak: "#a6a6b4",
  lcd: "#1cf01c",
  /** EQ slider fill, one colour per dB from -12 to +12. */
  eqRamp: Array.from({ length: 25 }, (_, i) =>
    ramp3(i / 24, [40, 200, 30], [230, 210, 40], [235, 60, 25]),
  ),
  eqCenter: "#4a4a64",
  eqPreampLine: "#6c6c7c",
  plSelectedBg: "#0000c6",
};

/* ---------- drawing tools ---------- */

function tools(g) {
  const R = (x, y, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(x, y, w, h);
  };
  const bevelBox = (x, y, w, h, face, hi, lo) => {
    R(x, y, w, h, face);
    R(x, y, w, 1, hi);
    R(x, y, 1, h, hi);
    R(x, y + h - 1, w, 1, lo);
    R(x + w - 1, y, 1, h, lo);
  };
  const recess = (x, y, w, h, inside = "#000") => {
    R(x, y, w, 1, "#121220");
    R(x, y, 1, h, "#121220");
    R(x, y + h - 1, w, 1, "#55556f");
    R(x + w - 1, y, 1, h, "#55556f");
    R(x + 1, y + 1, w - 2, h - 2, inside);
  };
  const silver = (x, y, w, h, down = false) => {
    R(x, y, w, h, "#06060a");
    const gr = g.createLinearGradient(0, y, 0, y + h);
    if (down) {
      gr.addColorStop(0, "#8e8ea0");
      gr.addColorStop(1, "#b4b4c2");
    } else {
      gr.addColorStop(0, "#dcdce6");
      gr.addColorStop(0.5, "#bdbdca");
      gr.addColorStop(1, "#9a9aab");
    }
    g.fillStyle = gr;
    g.fillRect(x + 1, y + 1, w - 2, h - 2);
    const [tl, tl2, br, br2] = down
      ? ["#5a5a70", "#62627a", "#d8d8e4", "#c8c8d6"]
      : ["#f7f7fc", "#ececf4", "#62627a", "#71718a"];
    R(x + 1, y + 1, w - 2, 1, tl);
    R(x + 1, y + 1, 1, h - 2, tl2);
    R(x + 1, y + h - 2, w - 2, 1, br);
    R(x + w - 2, y + 1, 1, h - 2, br2);
  };
  const darkBtn = (x, y, w, h, down = false) => {
    R(x, y, w, h, "#07070c");
    if (down) bevelBox(x + 1, y + 1, w - 2, h - 2, "#25253a", "#15151f", "#4a4a66");
    else bevelBox(x + 1, y + 1, w - 2, h - 2, "#33334a", "#5d5d7c", "#181824");
  };
  const led = (x, y, on) => {
    R(x, y, 3, 3, on ? "#3cff2e" : "#173317");
    if (on) R(x, y, 1, 1, "#c8ffbd");
  };
  const triR = (x, y, h, c) => {
    const w = (h + 1) / 2;
    for (let i = 0; i < w; i++) R(x + i, y + i, 1, h - 2 * i, c);
  };
  const triL = (x, y, h, c) => {
    const w = (h + 1) / 2;
    for (let i = 0; i < w; i++) R(x + w - 1 - i, y + i, 1, h - 2 * i, c);
  };
  const gw3 = (ch) => (F5[ch] ? 5 : 3);
  const t3w = (s) => [...s].reduce((w, ch) => w + gw3(ch) + 1, 0) - 1;
  const t3 = (s, x, y, c, align) => {
    if (align === "c") x = Math.round(x - t3w(s) / 2);
    if (align === "r") x -= t3w(s);
    g.fillStyle = c;
    for (const ch of s) {
      const w = gw3(ch);
      const m = w === 5 ? F5[ch] : F3[ch] || F3[" "];
      for (let b = 0; b < w * 5; b++)
        if (m[b] === "1") g.fillRect(x + (b % w), y + ((b / w) | 0), 1, 1);
      x += w + 1;
    }
  };
  const glyph = (ch, x, y, c) => {
    const rows = FONT[ch] || FONT[" "];
    g.fillStyle = c;
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 4; rx++) if (row[rx] === "#") g.fillRect(x + rx, y + ry, 1, 1);
    });
  };
  const text = (s, x, y, c) => [...s].forEach((ch, i) => glyph(ch, x + i * GLYPH_W, y, c));
  return { g, R, bevelBox, recess, silver, darkBtn, led, triR, triL, t3, t3w, glyph, text };
}

/* ---------- shared pieces ---------- */

const W = 275;

function frame(t, h) {
  const { g, R } = t;
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, "#34344c");
  gr.addColorStop(0.45, "#2b2b40");
  gr.addColorStop(1, "#212133");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, h);
  R(0, 0, W, 1, "#73738f");
  R(0, 0, 1, h, "#73738f");
  R(0, h - 1, W, 1, "#06060b");
  R(W - 1, 0, 1, h, "#06060b");
  R(1, h - 2, W - 2, 1, "#18182a");
  R(W - 2, 1, 1, h - 2, "#18182a");
}

/** A titlebar: gold ribs either side of the label, option button left, window buttons right. */
function titlebar(t, h, label, buttons, active) {
  const { g, R, silver, text } = t;
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, active ? "#2c2c48" : "#282836");
  gr.addColorStop(1, active ? "#1a1a2c" : "#1c1c26");
  g.fillStyle = gr;
  g.fillRect(1, 1, W - 2, h - 1);
  R(0, 0, W, 1, "#7a7a96");
  R(0, 0, 1, h, "#7a7a96");
  R(W - 1, 0, 1, h, "#06060b");
  const lw = label.length * GLYPH_W - 1;
  const lx = Math.round((W - lw) / 2);
  const ribs = h === 14 ? [3, 6, 9] : [5, 8, 11, 14];
  const ty = h === 14 ? 4 : 8;
  const [hi, lo, endL, endR] = active
    ? ["#f0dc94", "#86702e", "#a99245", "#6d5a24"]
    : ["#7c7562", "#3e3a30", "#5e5848", "#34302a"];
  const seg = (x0, x1) => {
    for (const r of ribs) {
      R(x0, r, x1 - x0, 1, hi);
      R(x0, r + 1, x1 - x0, 1, lo);
      R(x0, r, 1, 2, endL);
      R(x1 - 1, r, 1, 2, endR);
    }
  };
  seg(19, lx - 4);
  seg(lx + lw + 4, W - 10 - buttons * 10 - 2);
  text(label, lx, ty, active ? "#f6ecc4" : "#9a957f");
  silver(6, 3, 9, 9);
  R(8, 7, 5, 1, "#202030");
  for (let i = 0; i < buttons; i++) {
    const bx = W - 11 - i * 10;
    silver(bx, 3, 9, 9);
    const ic = "#1d1d2c";
    if (i === 0) closeGlyph(t, bx, 3, ic);
    else if (i === 1) {
      R(bx + 2, 5, 5, 1, ic);
      R(bx + 2, 7, 5, 1, ic);
    } else R(bx + 2, 9, 5, 1, ic);
  }
}

function closeGlyph(t, x, y, c) {
  for (let j = 0; j < 5; j++) {
    t.R(x + 2 + j, y + 2 + j, 1, 1, c);
    t.R(x + 6 - j, y + 2 + j, 1, 1, c);
  }
}

/* ---------- backgrounds ---------- */

function mainBg(t) {
  const { g, R, recess, t3 } = t;
  frame(t, 116);
  // clutterbar
  recess(10, 22, 8, 43, "#16162a");
  ["O", "A", "I", "D", "V"].forEach((c, i) => t3(c, 13, 24 + i * 8, "#8a8aa8"));
  // LCD with its dot grid
  recess(20, 22, 84, 41, "#000");
  for (let y = 0; y < 16; y += 2)
    for (let x = 0; x < 76; x += 2) R(24 + x, 44 + y, 1, 1, "#18212a");
  // readouts
  recess(108, 23, 158, 14, "#000");
  recess(108, 40, 20, 10, "#000");
  t3("KBPS", 131, 43, "#c7c7dc");
  recess(152, 40, 16, 10, "#000");
  t3("KHZ", 171, 43, "#c7c7dc");
  // slider wells
  recess(107, 58, 68, 11, "#0a0a12");
  recess(177, 58, 38, 11, "#0a0a12");
  recess(16, 72, 248, 10, "#101019");
  R(17, 76, 246, 2, "#07070c");
  // EKO badge where the lightning bolt sits
  R(250, 89, 17, 17, "#0b0b12");
  const bg = g.createRadialGradient(256, 95, 1, 258, 97, 9);
  bg.addColorStop(0, "#ffb070");
  bg.addColorStop(0.55, "#ef6a1e");
  bg.addColorStop(1, "#8a3005");
  g.fillStyle = bg;
  g.beginPath();
  g.arc(258.5, 97.5, 7.5, 0, Math.PI * 2);
  g.fill();
  R(255, 94, 6, 1, "#fff2e4");
  R(255, 94, 1, 7, "#fff2e4");
  R(255, 97, 5, 1, "#fff2e4");
  R(255, 100, 6, 1, "#fff2e4");
}

const FREQ_LABELS = ["60", "170", "310", "600", "1K", "3K", "6K", "12K", "14K", "16K"];

function eqBg(t) {
  const { R, recess, t3 } = t;
  frame(t, 116);
  recess(86, 17, 113, 19, "#000");
  for (let x = 88; x < 197; x += 2) R(x, 26, 1, 1, "#2c2c3c");
  t3("+12DB", 74, 39, "#c7c7dc", "r");
  t3("+0DB", 74, 67, "#c7c7dc", "r");
  t3("-12DB", 74, 95, "#c7c7dc", "r");
  recess(25, 38, 6, 63, "#09090f");
  t3("PREAMP", 28, 104, "#c7c7dc", "c");
  FREQ_LABELS.forEach((label, i) => {
    recess(82 + i * 18, 38, 6, 63, "#09090f");
    t3(label, 85 + i * 18, 104, "#c7c7dc", "c");
  });
}

function plBg(t) {
  const { R, recess, triL, triR } = t;
  const h = 145;
  frame(t, h);
  for (let y = 20; y < h - 38; y += 3) {
    R(4, y, 4, 1, "#3d3d56");
    R(4, y + 1, 4, 1, "#1b1b29");
  }
  R(11, 20, 245, 87, "#000");
  R(11, 20, 1, 87, "#121220");
  R(255, 20, 1, 87, "#55556f");
  recess(260, 20, 10, 87, "#13131f");
  R(1, 107, W - 2, 1, "#55556f");
  recess(130, 113, 98, 11, "#000");
  recess(183, 127, 45, 10, "#000");
  // mini transport, printed
  const c = "#c7c7dc";
  const mx = 131;
  const my = 129;
  R(mx, my, 1, 5, c);
  triL(mx + 1, my, 5, c);
  triR(mx + 9, my, 5, c);
  R(mx + 15, my, 1, 5, c);
  R(mx + 17, my, 1, 5, c);
  R(mx + 22, my, 5, 5, c);
  triR(mx + 30, my, 5, c);
  R(mx + 33, my, 1, 5, c);
  R(mx + 38, my + 3, 5, 2, c);
  R(mx + 40, my, 1, 1, c);
  R(mx + 39, my + 1, 3, 1, c);
  R(mx + 38, my + 2, 5, 1, c);
}

/* ---------- sprite painters ---------- */

const IC = "#1a1a28";

/** Transport icons, drawn relative to the button's top-left. */
const TRANSPORT = {
  btnPrev: (t, o) => {
    t.R(5 + o, 5 + o, 2, 8, IC);
    t.triL(7 + o, 5 + o, 9, IC);
    t.triL(12 + o, 5 + o, 9, IC);
  },
  btnPlay: (t, o) => t.triR(9 + o, 4 + o, 11, IC),
  btnPause: (t, o) => {
    t.R(7 + o, 5 + o, 3, 9, IC);
    t.R(12 + o, 5 + o, 3, 9, IC);
  },
  btnStop: (t, o) => t.R(7 + o, 5 + o, 9, 9, IC),
  btnNext: (t, o) => {
    t.triR(4 + o, 5 + o, 9, IC);
    t.triR(9 + o, 5 + o, 9, IC);
    t.R(14 + o, 5 + o, 2, 9, IC);
  },
  btnEject: (t, o) => {
    for (let i = 0; i < 5; i++) t.R(11 - i + o, 3 + i + o, 1 + 2 * i, 1, IC);
    t.R(6 + o, 9 + o, 11, 2, IC);
  },
};

const FOOTER = { plAdd: "ADD", plRem: "REM", plSel: "SEL", plMisc: "MISC", plList: "LIST" };

function volumeFrame(t, i) {
  const level = i / (VOLUME_FRAMES - 1);
  const c = ramp3(level, [40, 214, 32], [226, 206, 36], [230, 70, 28]);
  t.recess(0, 0, 68, 11, "#0a0a12");
  for (let k = 0; k < 66; k++) {
    const hh = 1 + Math.round((k / 65) * 7);
    t.R(1 + k, 9 - hh, 1, hh, k / 65 <= level ? c : "#24243a");
  }
}

function toggle(t, w, label, on, labelX) {
  t.darkBtn(0, 0, w, 12);
  t.led(3, 4, on);
  t.t3(label, labelX, 4, on ? "#e6e6f6" : "#9c9cb8");
}

function repeatGlyph(t, c) {
  const { R } = t;
  R(10, 4, 11, 1, c);
  R(10, 4, 1, 4, c);
  R(20, 7, 1, 4, c);
  R(10, 10, 11, 1, c);
  R(18, 3, 1, 3, c);
  R(12, 9, 1, 3, c);
}

function paintSprite(t, name, w, h) {
  const down = name.endsWith("Down");
  const base = down ? name.slice(0, -4) : name;
  const o = down ? 1 : 0;
  const { R, silver, darkBtn, led, t3, recess, triR } = t;

  if (TRANSPORT[base]) {
    silver(0, 0, w, h, down);
    TRANSPORT[base](t, o);
    return;
  }
  if (FOOTER[base]) {
    darkBtn(0, 0, w, h, down);
    t3(FOOTER[base], 14 + o, 7 + o, "#d6d6ea", "c");
    return;
  }
  if (base.startsWith("vol") && /^vol\d+$/.test(base)) {
    volumeFrame(t, Number(base.slice(3)));
    return;
  }

  switch (base) {
    case "mainBg":
      return mainBg(t);
    case "eqBg":
      return eqBg(t);
    case "plBg":
      return plBg(t);
    case "titleActive":
    case "titleInactive":
      return titlebar(t, 14, "EKO-AMP", 3, base === "titleActive");
    case "eqTitleActive":
    case "eqTitleInactive":
      return titlebar(t, 14, "EKO-AMP EQUALIZER", 2, base === "eqTitleActive");
    case "plTitleActive":
    case "plTitleInactive":
      return titlebar(t, 20, "EKO-AMP PLAYLIST", 2, base === "plTitleActive");
    case "closeBtn":
      silver(0, 0, 9, 9, down);
      return closeGlyph(t, o, o, "#1d1d2c");
    case "posThumb":
      silver(0, 0, w, h, down);
      for (let i = 0; i < 4; i++) R(10 + i * 3 + o, 2 + o, 1, 6, "#73738c");
      return;
    case "posFill":
      R(0, 0, w, 1, "#2a9a24");
      R(0, 1, w, 1, "#1d6e1a");
      return;
    case "volThumb":
    case "balThumb":
      silver(0, 0, w, h, down);
      return R(6 + o, 3 + o, 2, 5, "#6a6a80");
    case "balBg":
      recess(0, 0, 38, 11, "#0a0a12");
      R(1, 4, 36, 3, "#2bd022");
      return R(1, 4, 36, 1, "#7cf06a");
    case "shuffleOff":
    case "shuffleOn": {
      const on = base === "shuffleOn";
      darkBtn(0, 0, w, h);
      led(4, 6, on);
      return t3("SHUFFLE", 10, 5, on ? "#e6e6f6" : "#9c9cb8");
    }
    case "repeatOff":
    case "repeatOn": {
      const on = base === "repeatOn";
      darkBtn(0, 0, w, h);
      led(4, 6, on);
      return repeatGlyph(t, on ? "#e6e6f6" : "#9c9cb8");
    }
    case "eqToggleOff":
    case "eqToggleOn":
      return toggle(t, w, "EQ", base === "eqToggleOn", 10);
    case "plToggleOff":
    case "plToggleOn":
      return toggle(t, w, "PL", base === "plToggleOn", 10);
    case "eqOnOff":
    case "eqOnOn":
      return toggle(t, w, "ON", base === "eqOnOn", 11);
    case "eqAutoOff":
    case "eqAutoOn":
      return toggle(t, w, "AUTO", base === "eqAutoOn", 11);
    case "presets":
      darkBtn(0, 0, w, h, down);
      return t3("PRESETS", 22 + o, 4 + o, "#e6e6f6", "c");
    case "mono":
    case "monoLit":
      recess(0, 0, w, h, "#000");
      return t3("MONO", 4, 3, base === "monoLit" ? "#3cff2e" : "#2a3a2a");
    case "stereo":
    case "stereoLit":
      recess(0, 0, w, h, "#000");
      return t3("STEREO", 4, 3, base === "stereoLit" ? "#3cff2e" : "#2a3a2a");
    case "playInd":
      R(0, 0, w, h, "#000");
      R(0, 0, 1, 9, "#0f8f0f");
      triR(2, 0, 9, "#21e021");
      return R(2, 0, 1, 9, "#7dff6a");
    case "pauseInd":
      R(0, 0, w, h, "#000");
      R(0, 0, 1, 9, "#0f8f0f");
      R(2, 0, 3, 9, "#21e021");
      R(6, 0, 3, 9, "#21e021");
      R(2, 0, 1, 9, "#7dff6a");
      return R(6, 0, 1, 9, "#7dff6a");
    case "stopInd":
      R(0, 0, w, h, "#000");
      R(0, 0, 1, 9, "#0f8f0f");
      R(2, 1, 7, 7, "#21e021");
      return R(2, 1, 7, 1, "#7dff6a");
    case "eqSliderThumb":
      silver(0, 0, w, h, down);
      return R(2 + o, 5 + o, 8, 1, "#6a6a82");
    case "plScrollThumb":
      silver(0, 0, w, h);
      for (let i = 0; i < 3; i++) R(2, 6 + i * 2, 4, 1, "#6a6a82");
      return;
    default:
      throw new Error(`base skin has no painter for ${name}`);
  }
}

/* ---------- digits and text sheets ---------- */

const SEG = {
  a: [1, 0, 6, 2],
  b: [6, 1, 2, 5],
  c: [6, 6, 2, 5],
  d: [1, 10, 6, 2],
  e: [0, 6, 2, 5],
  f: [0, 1, 2, 5],
  g: [1, 5, 6, 2],
};
const DIG = [
  "abcdef",
  "bc",
  "abged",
  "abgcd",
  "fgbc",
  "afgcd",
  "afgedc",
  "abc",
  "abcdefg",
  "abcdfg",
];

function paintNumbers(t) {
  const { R } = t;
  for (let n = 0; n < 12; n++) {
    const x = n * DIGIT_W;
    R(x, 0, DIGIT_W, DIGIT_H, "#000");
    const lit = n < 10 ? DIG[n] : n === 11 ? "g" : "";
    if (n !== 11) for (const s in SEG) R(x + SEG[s][0], SEG[s][1], SEG[s][2], SEG[s][3], "#091809");
    for (const s of lit) R(x + SEG[s][0], SEG[s][1], SEG[s][2], SEG[s][3], "#1cf01c");
    for (const s of lit) R(x + SEG[s][0], SEG[s][1], SEG[s][2], 1, "#8dff7e");
  }
}

function paintText(t) {
  const colors = { green: "#1df21d", white: "#ffffff", dim: "#8a8aa8" };
  for (const [name, row] of Object.entries(TEXT_ROWS)) {
    [...GLYPHS].forEach((ch, i) => t.glyph(ch, i * GLYPH_W, row * GLYPH_H, colors[name]));
  }
}

/* ---------- entry point ---------- */

/** @returns {{ sheets: Record<string, HTMLCanvasElement>, palette: typeof PALETTE }} */
export function paintBaseSkin() {
  const sheets = {};
  for (const [name, { w, h }] of Object.entries(SHEETS)) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    sheets[name] = c;
  }
  paintNumbers(tools(sheets.NUMBERS.getContext("2d")));
  paintText(tools(sheets.TEXT.getContext("2d")));
  for (const [name, s] of Object.entries(S)) {
    const g = sheets[s.sheet].getContext("2d");
    g.save();
    g.translate(s.x, s.y);
    g.beginPath();
    g.rect(0, 0, s.w, s.h);
    g.clip();
    paintSprite(tools(g), name, s.w, s.h);
    g.restore();
  }
  return { sheets, palette: PALETTE };
}
