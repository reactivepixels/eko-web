/**
 * The GT-1's screen, after the mockup: two dot-matrix lanes either side of the seam, and a
 * sample-level zoom of the seam on the right. Before you guess, both lanes show the music as
 * written, identical. After, they show what each player actually sent out.
 */
import { columns, formatSamples } from "../audio/seam.js";

export const W = 660;
export const H = 268;
const LX = 62;
const LW = 356;
const BX = LX + LW / 2;
/** The lanes show half a second either side of the seam. */
const SPAN = 1;
const PPS = LW / SPAN;
const LANES = [
  { y: 42, h: 80 },
  { y: 138, h: 80 },
];
const ZX = 446;
const ZW = 200;
const ZN = 41;
const ZC = 20;
const COL = 3;
const NCOL = Math.floor(LW / COL);

const ORANGE = "#ef6a1e";

function mono(c, size, weight = 500) {
  c.font = `${weight} ${size}px "Geist Mono", ui-monospace, Menlo, monospace`;
}
function dot(c, size, weight = 800) {
  c.font = `${weight} ${size}px "Doto", "Geist Mono", monospace`;
}

function hatch(c, x, y, w, h) {
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.strokeStyle = "rgba(239,106,30,.32)";
  c.lineWidth = 1;
  for (let k = -h; k < w; k += 4) {
    c.beginPath();
    c.moveTo(x + k, y + h);
    c.lineTo(x + k + h, y);
    c.stroke();
  }
  c.restore();
}

/**
 * Peak columns for one lane: `samples` around `at` (the seam), half a second either side.
 * Cached per capture, since captures do not change once taken.
 */
const cache = new WeakMap();
function laneColumns(samples, at, rate) {
  let entry = cache.get(samples);
  if (!entry || entry.at !== at) {
    const half = (SPAN / 2) * rate;
    entry = { at, cols: columns(samples, at - half, at + half, NCOL) };
    cache.set(samples, entry);
  }
  return entry.cols;
}

/**
 * @param {CanvasRenderingContext2D} c  already scaled to W x H
 * @param {object} s  everything the screen shows; see app.js `screenState()`
 */
export function drawScreen(c, s) {
  c.clearRect(0, 0, W, H);

  // Header line.
  mono(c, 8.5, 600);
  c.textAlign = "left";
  c.fillStyle = "rgba(233,231,224,.85)";
  const head = `ROUND ${String(s.round + 1).padStart(2, "0")}/${String(s.count).padStart(2, "0")}`;
  c.fillText(head, 14, 20);
  const hw = c.measureText(head).width;
  mono(c, 8.5, 500);
  c.fillStyle = "rgba(233,231,224,.42)";
  const title = `  ·  ${s.from.toUpperCase()}  ›  ${s.to.toUpperCase()}  ·  ${s.side.toUpperCase()}`;
  c.fillText(fit(c, title, 430 - 14 - hw), 14 + hw, 20);
  mono(c, 8.5, 600);
  c.fillStyle = "rgba(233,231,224,.85)";
  c.fillText("ZOOM", ZX, 20);
  mono(c, 8.5, 500);
  c.fillStyle = "rgba(233,231,224,.42)";
  // How much closer the zoom is than the lanes: samples per pixel, lanes over zoom.
  const zoom = Math.round((s.rate * SPAN) / LW / (ZN / ZW));
  c.fillText(`\u00d7${zoom}   N\u2080\u00b1${ZC}`, ZX + 30, 20);
  c.textAlign = "right";
  c.fillStyle = s.revealed ? "rgba(233,231,224,.75)" : "rgba(233,231,224,.42)";
  c.fillText(s.status, W - 14, 20);
  if (s.revealed || s.playing) {
    c.fillStyle = ORANGE;
    c.beginPath();
    c.arc(W - 14 - c.measureText(s.status).width - 9, 17, 3, 0, Math.PI * 2);
    c.fill();
  }

  // Lane letters and, once revealed, who was who.
  ["A", "B"].forEach((side, li) => {
    const ln = LANES[li];
    dot(c, 34);
    c.textAlign = "left";
    c.fillStyle = "#f1efe8";
    c.fillText(side, 14, ln.y + 28);
    const who = s.revealed ? (s.eko === side ? "eko" : "tag") : null;
    mono(c, 7.5, 700);
    if (who) {
      const label = who === "eko" ? "EKO" : "<AUDIO>";
      const w = c.measureText(label).width + 6;
      c.fillStyle = who === "eko" ? ORANGE : "rgba(233,231,224,.55)";
      c.fillRect(14, ln.y + 36, w, 12);
      c.fillStyle = "#141310";
      c.fillText(label, 17, ln.y + 45);
      mono(c, 7.5, 600);
      c.fillStyle = "rgba(233,231,224,.45)";
      const [l1, l2] = who === "eko" ? ["WEB", "AUDIO"] : ["BARE", "TAG"];
      c.fillText(l1, 14, ln.y + 62);
      c.fillText(l2, 14, ln.y + 72);
    } else {
      c.fillStyle = "rgba(233,231,224,.35)";
      c.fillText(s.heard[side] ? "HEARD" : "NOT YET", 14, ln.y + 46);
      c.fillText("PLAYED", 14, ln.y + 56);
    }
  });

  // Lanes.
  LANES.forEach((ln, li) => {
    const side = li === 0 ? "A" : "B";
    const lane = s.lanes[side];
    const cy = ln.y + ln.h / 2;
    c.fillStyle = "rgba(233,231,224,.13)";
    for (let gx = 0; gx <= LW; gx += LW / 40) {
      const X = Math.round(LX + gx);
      c.fillRect(X, ln.y, 1, 1);
      c.fillRect(X, ln.y + ln.h - 1, 1, 1);
    }
    c.fillStyle = "rgba(233,231,224,.07)";
    c.fillRect(LX, cy, LW, 1);
    const cols = laneColumns(lane.samples, lane.at, lane.rate);
    const rows = Math.floor((ln.h / 2 - 3) / 3);
    const active = s.playing === side;
    const px = active ? s.playhead : null;
    for (let i = 0; i < cols.length; i++) {
      const x = LX + i * COL + 1;
      if (cols[i] < 1e-4) continue;
      const n = Math.max(1, Math.round(Math.min(0.98, cols[i] * 1.25) * rows));
      const played = px !== null && x < px;
      c.fillStyle = played
        ? "rgba(246,244,238,.96)"
        : active
          ? "rgba(233,231,224,.34)"
          : "rgba(233,231,224,.26)";
      for (let r = 0; r < n; r++) {
        c.fillRect(x, cy - 1 - r * 3 - 1, 2, 2);
        c.fillRect(x, cy + 1 + r * 3, 2, 2);
      }
    }
    if (px !== null && px >= LX && px <= LX + LW) {
      const g = c.createLinearGradient(px - 18, 0, px, 0);
      g.addColorStop(0, "rgba(239,106,30,0)");
      g.addColorStop(1, "rgba(239,106,30,.22)");
      c.fillStyle = g;
      c.fillRect(px - 18, ln.y, 18, ln.h);
      c.fillStyle = ORANGE;
      c.fillRect(Math.round(px), ln.y - 2, 1.5, ln.h + 4);
      c.beginPath();
      c.arc(Math.round(px) + 0.75, ln.y - 3, 2.6, 0, Math.PI * 2);
      c.fill();
    }
  });

  // The seam line across both lanes.
  c.strokeStyle = "rgba(233,231,224,.5)";
  c.lineWidth = 1;
  c.setLineDash([2, 3]);
  c.beginPath();
  c.moveTo(BX + 0.5, 34);
  c.lineTo(BX + 0.5, 224);
  c.stroke();
  c.setLineDash([]);
  mono(c, 8, 600);
  c.textAlign = "center";
  c.fillStyle = "rgba(233,231,224,.6)";
  c.fillText(`${s.fromNo}  │  ${s.toNo}`, BX + 0.5, 31);

  if (s.revealed) {
    ["A", "B"].forEach((side, li) => {
      const ln = LANES[li];
      const m = s.lanes[side].seam;
      if (m.valid === false) {
        mono(c, 8, 700);
        c.textAlign = "left";
        c.fillStyle = "rgba(233,231,224,.6)";
        c.fillText("NOT MEASURED  \u00b7  CAPTURE INCOMPLETE", BX + 8, ln.y + 3);
      } else if (m.samples > 0) {
        const gw = Math.max(1, (m.samples / s.lanes[side].rate) * PPS);
        hatch(c, BX + 1, ln.y + 4, gw, ln.h - 8);
        c.strokeStyle = "rgba(239,106,30,.75)";
        c.strokeRect(BX + 0.5, ln.y + 4.5, gw, ln.h - 9);
        mono(c, 8, 700);
        c.textAlign = "left";
        c.fillStyle = ORANGE;
        const ms = `${m.ms.toFixed(1)} MS`;
        c.fillText(ms, BX + gw + 6, ln.y + 3);
        mono(c, 7.5, 500);
        c.fillStyle = "rgba(239,106,30,.75)";
        c.fillText(
          `·  ${formatSamples(m.samples)} SMP SILENCE`,
          BX + gw + 12 + c.measureText(ms).width,
          ln.y + 3,
        );
      } else {
        c.fillStyle = ORANGE;
        c.beginPath();
        c.moveTo(BX - 3, ln.y - 1);
        c.lineTo(BX + 4, ln.y - 1);
        c.lineTo(BX + 0.5, ln.y + 4);
        c.closePath();
        c.fill();
        mono(c, 8, 700);
        c.textAlign = "right";
        c.fillStyle = "rgba(244,242,235,.92)";
        c.fillText("0 SMP", BX - 8, ln.y + 3);
        mono(c, 7.5, 500);
        c.fillStyle = "rgba(233,231,224,.5)";
        c.fillText("SAMPLE-ACCURATE SEAM  ·", BX - 42, ln.y + 3);
      }
    });
  }

  // Time ruler: half a second either side of the seam.
  const ry = 232;
  c.fillStyle = "rgba(233,231,224,.35)";
  for (let i = 0; i <= 20; i++)
    c.fillRect(Math.round(LX + (i * LW) / 20), ry, 1, i % 5 === 0 ? 6 : 3);
  mono(c, 7.5, 500);
  [
    ["-0.50 S", "left"],
    ["-0.25", "center"],
    [s.seamClock, "center"],
    ["+0.25", "center"],
    ["+0.50 S", "right"],
  ].forEach(([t, al], i) => {
    c.textAlign = al;
    c.fillStyle = i === 2 ? "rgba(244,242,235,.85)" : "rgba(233,231,224,.42)";
    c.fillText(t, LX + (i * LW) / 4, ry + 17);
  });

  c.fillStyle = "rgba(233,231,224,.1)";
  c.fillRect(432, 30, 1, 222);

  // Zoom plots share one vertical scale, fitted to the samples on show, so a quiet passage
  // still shows its shape. The corner labels give the real range.
  let zoomPeak = 0;
  if (s.revealed) {
    for (const side of ["A", "B"]) {
      const lane = s.lanes[side];
      for (let k = -ZC; k <= ZC; k++)
        zoomPeak = Math.max(zoomPeak, Math.abs(lane.samples[lane.at + k] ?? 0));
    }
  }
  const range = zoomPeak > 0 ? Math.min(1, niceRange(zoomPeak)) : 1;
  const yOf = (v) => Math.max(-1, Math.min(1, v / range));

  // Zoom plots.
  LANES.forEach((ln, li) => {
    const side = li === 0 ? "A" : "B";
    const lane = s.lanes[side];
    const x0 = ZX;
    const y0 = ln.y;
    const w = ZW;
    const h = ln.h;
    const cy = y0 + h / 2;
    c.fillStyle = "rgba(233,231,224,.035)";
    c.fillRect(x0, y0, w, h);
    c.fillStyle = "rgba(233,231,224,.08)";
    for (let i = 1; i < 10; i++) c.fillRect(Math.round(x0 + (i * w) / 10), y0, 1, h);
    for (let j = 1; j < 4; j++) c.fillRect(x0, Math.round(y0 + (j * h) / 4), w, 1);
    c.strokeStyle = "rgba(233,231,224,.5)";
    c.lineWidth = 1;
    for (const [x, y, sx, sy] of [
      [x0, y0, 1, 1],
      [x0 + w, y0, -1, 1],
      [x0, y0 + h, 1, -1],
      [x0 + w, y0 + h, -1, -1],
    ]) {
      c.beginPath();
      c.moveTo(x + 0.5 * sx + 6 * sx, y + 0.5 * sy);
      c.lineTo(x + 0.5 * sx, y + 0.5 * sy);
      c.lineTo(x + 0.5 * sx, y + 0.5 * sy + 6 * sy);
      c.stroke();
    }
    mono(c, 7.5, 700);
    c.textAlign = "left";
    c.fillStyle = "rgba(233,231,224,.7)";
    c.fillText(side, x0 + 5, y0 + 11);
    mono(c, 7.5, 500);
    c.textAlign = "right";
    c.fillStyle = "rgba(233,231,224,.4)";
    c.fillText(`+${range.toFixed(range < 0.1 ? 3 : 2)}`, x0 + w - 4, y0 + 11);
    c.fillText(`-${range.toFixed(range < 0.1 ? 3 : 2)}`, x0 + w - 4, y0 + h - 5);

    if (!s.revealed) {
      mono(c, 7.5, 600);
      c.textAlign = "center";
      c.fillStyle = "rgba(233,231,224,.32)";
      c.fillText("SEAM HIDDEN UNTIL YOU GUESS", x0 + w / 2, cy + 3);
      return;
    }
    const sx = w / (ZN + 1);
    const nx = x0 + (ZC + 1) * sx;
    const gap = lane.seam.samples > 0;
    c.fillStyle = gap ? "rgba(239,106,30,.55)" : "rgba(233,231,224,.4)";
    c.fillRect(Math.round(nx - sx / 2), y0 + 3, 1, h - 6);
    if (gap) {
      c.fillStyle = "rgba(239,106,30,.1)";
      const from = Math.round(nx - sx / 2) + 1;
      const until = Math.min(x0 + w - 1, nx - sx / 2 + Math.min(lane.seam.samples, ZN) * sx);
      c.fillRect(from, y0 + 1, until - from, h - 2);
    }
    const at = (k) => lane.samples[lane.at + k] ?? 0;
    c.strokeStyle = "rgba(233,231,224,.18)";
    c.beginPath();
    for (let k = 0; k < ZN; k++) {
      const x = x0 + (k + 1) * sx;
      const y = cy - yOf(at(k - ZC)) * h * 0.42;
      if (k) c.lineTo(x, y);
      else c.moveTo(x, y);
    }
    c.stroke();
    for (let k = 0; k < ZN; k++) {
      const n = k - ZC;
      const v = yOf(at(n));
      const x = Math.round(x0 + (k + 1) * sx) + 0.5;
      const y = cy - v * h * 0.42;
      const dead = gap && n >= 0 && n < lane.seam.samples;
      if (!dead) {
        c.strokeStyle = "rgba(233,231,224,.45)";
        c.beginPath();
        c.moveTo(x, cy + 0.5);
        c.lineTo(x, y);
        c.stroke();
      }
      c.fillStyle = dead || n === 0 ? ORANGE : "#f1efe8";
      c.beginPath();
      c.arc(x, y, dead ? 1.5 : 1.9, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = ORANGE;
    c.beginPath();
    c.arc(Math.round(nx) + 0.5, cy - yOf(at(0)) * h * 0.42, 4.5, 0, Math.PI * 2);
    c.stroke();
    if (gap) {
      mono(c, 7.5, 600);
      c.textAlign = "left";
      c.fillStyle = ORANGE;
      c.fillText("0.0000 ›", Math.round(nx) + 8, cy + 13);
    }
  });

  // Zoom readouts.
  mono(c, 7.5, 500);
  c.textAlign = "left";
  c.fillStyle = "rgba(233,231,224,.42)";
  const seamLane = s.revealed ? s.lanes[s.eko === "A" ? "B" : "A"] : null;
  c.fillText(
    seamLane
      ? `N₀ = ${formatSamples(seamLane.at)} / ${(s.rate / 1000).toFixed(1)} KHZ`
      : `${(s.rate / 1000).toFixed(1)} KHZ OUTPUT`,
    ZX,
    240,
  );
  c.textAlign = "right";
  c.fillText("1 DIV = 4 SMP", ZX + ZW, 240);
  if (s.revealed) {
    mono(c, 8, 700);
    c.textAlign = "left";
    ["A", "B"].forEach((side, i) => {
      const m = s.lanes[side].seam;
      c.fillStyle = m.samples > 0 ? ORANGE : "rgba(244,242,235,.9)";
      const delta = m.valid === false ? "?" : formatSamples(m.samples);
      c.fillText(`${side}  \u0394 ${delta}`, ZX + i * 62, 254);
    });
  } else {
    mono(c, 8, 600);
    c.textAlign = "left";
    c.fillStyle = "rgba(233,231,224,.55)";
    c.fillText(s.hint, ZX, 254);
  }
}

/** Round a peak up to 1, 2 or 5 times a power of ten, for a readable axis label. */
function niceRange(peak) {
  const p = Math.pow(10, Math.floor(Math.log10(peak)));
  for (const m of [1, 2, 5, 10]) if (peak <= m * p) return m * p;
  return 10 * p;
}

function fit(c, text, width) {
  if (c.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 4 && c.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}
