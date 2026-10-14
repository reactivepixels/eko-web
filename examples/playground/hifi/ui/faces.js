/**
 * Printed and moulded parts drawn as SVG: tick rings, the volume scale, the VU faces and
 * the cassette. Built once; the page only moves needles, spools and drums afterwards.
 */
import { vuAngle } from "../audio/meters.js";

const f2 = (n) => n.toFixed(2);

function polar(cx, cy, deg, r) {
  const a = (deg * Math.PI) / 180;
  return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
}

const line = (p1, p2, stroke, width, opacity = 1) =>
  `<line x1="${f2(p1[0])}" y1="${f2(p1[1])}" x2="${f2(p2[0])}" y2="${f2(p2[1])}" stroke="${stroke}" stroke-width="${width}" stroke-opacity="${opacity}"/>`;

/** Ticks around a knob: `n` marks over +/- `span` degrees, ends and centre heavier. */
export function tickRing(svg, n, span) {
  const w = Number(svg.getAttribute("width"));
  const c = w / 2;
  let out = "";
  for (let i = 0; i < n; i++) {
    const a = -span + 2 * span * (n === 1 ? 0.5 : i / (n - 1));
    const big = i === 0 || i === n - 1 || i === (n - 1) / 2;
    out += line(
      polar(c, c, a, big ? c - 7 : c - 6),
      polar(c, c, a, c - 2),
      "#cdc8bd",
      big ? 1 : 0.7,
      big ? 0.85 : 0.55,
    );
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${w}`);
  svg.innerHTML = out;
}

/** The volume knob's printed attenuation scale. */
export function volumeScale(svg, marks) {
  const c = 66;
  let out = "";
  for (let i = 0; i <= 40; i++) {
    const a = -140 + (280 * i) / 40;
    const big = i % 5 === 0;
    out += line(
      polar(c, c, a, big ? 53 : 55),
      polar(c, c, a, 59),
      "#cdc8bd",
      big ? 1 : 0.6,
      big ? 0.9 : 0.5,
    );
  }
  marks.forEach((label, i) => {
    const [x, y] = polar(c, c, -140 + 35 * i, 64.5);
    out += `<text x="${f2(x)}" y="${f2(y + 2)}" fill="#8f8a80" font-size="5.5" font-family="Archivo, sans-serif" font-weight="600" text-anchor="middle">${label}</text>`;
  });
  svg.setAttribute("viewBox", "0 0 132 132");
  svg.innerHTML = out;
}

export const VU_PIVOT = [71, 124];

/** A VU face, after the mockup. Returns the needle group to rotate. */
export function vuFace(el, side) {
  const [CX, CY] = VU_PIVOT;
  const pol = (a, r) => polar(CX, CY, a, r);
  const L0 = Math.pow(10, -20 / 20);
  const L3 = Math.pow(10, 3 / 20);
  const pct = (p) => -38 + (76 * (p / 100 - L0)) / (L3 - L0);
  const arc = (a1, a2, r) => {
    const p1 = pol(a1, r);
    const p2 = pol(a2, r);
    return `M${f2(p1[0])} ${f2(p1[1])} A${r} ${r} 0 0 1 ${f2(p2[0])} ${f2(p2[1])}`;
  };
  let s = `<svg width="142" height="90" viewBox="0 0 142 90" aria-hidden="true">`;
  s += `<defs><radialGradient id="bl${side}" cx="50%" cy="95%" r="95%"><stop offset="0" stop-color="#ffe2a6"/><stop offset=".45" stop-color="#f5c46f"/><stop offset=".8" stop-color="#d88e33"/><stop offset="1" stop-color="#9c5714"/></radialGradient>`;
  s += `<linearGradient id="sh${side}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b1b"/><stop offset="1" stop-color="#000"/></linearGradient></defs>`;
  s += `<rect class="vu-paper" width="142" height="90" fill="url(#bl${side})"/>`;
  s += `<path d="${arc(vuAngle(-20), vuAngle(0), 86)}" fill="none" stroke="#24180c" stroke-width=".9"/>`;
  s += `<path d="${arc(vuAngle(0), vuAngle(3), 87.6)}" fill="none" stroke="#c4200f" stroke-width="4"/>`;
  s += `<path d="${arc(vuAngle(0), vuAngle(3), 86)}" fill="none" stroke="#c4200f" stroke-width=".9"/>`;
  for (const d of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
    const a = vuAngle(d);
    const red = d > 0;
    const major = [-20, -10, -7, -5, -3, 0, 3].includes(d);
    s += line(pol(a, 86), pol(a, major ? 94 : 91), red ? "#c4200f" : "#24180c", major ? 1.1 : 0.8);
    const lp = pol(a, 101);
    const txt = d > 0 ? `+${d}` : d === 0 ? "0" : String(-d);
    s += `<text x="${f2(lp[0])}" y="${f2(lp[1] + 2.4)}" font-size="${d === 0 ? 7.5 : 6.5}" font-family="Archivo, sans-serif" font-weight="${d === 0 ? 700 : 600}" fill="${red || d === 0 ? "#c4200f" : "#24180c"}" text-anchor="middle">${txt}</text>`;
  }
  for (let d = -19; d < -10; d++) {
    const a = vuAngle(d);
    s += line(pol(a, 86), pol(a, 88.5), "#24180c", 0.5);
  }
  s += `<path d="${arc(pct(10), pct(100), 76)}" fill="none" stroke="#24180c" stroke-width=".6" stroke-opacity=".8"/>`;
  for (const p of [20, 40, 60, 80, 100]) {
    const a = pct(p);
    const lp = pol(a, 67);
    s += line(pol(a, 76), pol(a, 72.5), "#24180c", 0.6);
    s += `<text x="${f2(lp[0])}" y="${f2(lp[1] + 1.8)}" font-size="4.6" font-family="Archivo, sans-serif" fill="#3a2a16" text-anchor="middle">${p}</text>`;
  }
  s += `<text x="8" y="14" font-size="6.5" font-family="Archivo, sans-serif" font-weight="700" fill="#24180c">−</text>`;
  s += `<text x="134" y="14" font-size="6.5" font-family="Archivo, sans-serif" font-weight="700" fill="#c4200f" text-anchor="end">+</text>`;
  s += `<text x="71" y="74" font-size="12" font-family="Archivo, sans-serif" font-weight="800" fill="#24180c" text-anchor="middle" letter-spacing="1" font-stretch="125%">VU</text>`;
  s += `<text x="7" y="86" font-size="4.6" font-family="Archivo, sans-serif" font-weight="700" fill="#3a2a16" letter-spacing="1">${side === "L" ? "LEFT" : "RIGHT"}</text>`;
  s += `<text x="135" y="86" font-size="4.6" font-family="Archivo, sans-serif" font-weight="800" fill="#3a2a16" letter-spacing="1.4" text-anchor="end">EKO</text>`;
  s += `<g class="needle" transform="rotate(${f2(vuAngle(-40))} ${CX} ${CY})">`;
  s += `<line x1="${CX + 1.4}" y1="${CY + 1.6}" x2="${CX + 1.4}" y2="${CY - 95}" stroke="rgba(60,25,0,.22)" stroke-width="1.6"/>`;
  s += `<line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - 97}" stroke="#14100b" stroke-width=".95"/>`;
  s += `<line x1="${CX}" y1="${CY - 82}" x2="${CX}" y2="${CY - 97}" stroke="#a5180a" stroke-width="1.1"/></g>`;
  s += `<path d="M30 90 Q71 66 112 90 Z" fill="url(#sh${side})"/>`;
  s += `<path d="M30 90 Q71 66 112 90" fill="none" stroke="rgba(255,220,160,.25)" stroke-width=".6"/>`;
  s += `<circle cx="71" cy="86" r="1.6" fill="#3a3a3a"/></svg>`;
  el.innerHTML = s;
  return el.querySelector(".needle");
}

/** Hub centres and scale (px per mm) of the cassette drawing. */
export const CASSETTE = {
  w: 164,
  h: 104,
  hubs: [
    [47.3, 47],
    [116.7, 47],
  ],
  pxPerMm: 1.6,
};

function sprocket(cx, cy) {
  let teeth = "";
  for (let i = 0; i < 6; i++) {
    const a = i * 60;
    teeth += `<rect x="${f2(cx - 0.9)}" y="${f2(cy - 6.6)}" width="1.8" height="2.4" rx=".4" fill="#f4f1ea" transform="rotate(${a} ${cx} ${cy})"/>`;
  }
  return `<g class="hub" data-cx="${cx}" data-cy="${cy}"><circle cx="${cx}" cy="${cy}" r="7.2" fill="#f4f1ea"/><circle cx="${cx}" cy="${cy}" r="4.6" fill="#1a1612"/>${teeth}</g>`;
}

/**
 * The cassette: black shell, cream label with an orange band, a window onto both tape
 * packs, and a handwritten title. Returns the moving parts.
 */
export function cassette(el) {
  const { w, h, hubs } = CASSETTE;
  const [[x1, y1], [x2, y2]] = hubs;
  const win = { x: 30, y: 35, w: 104, h: 24 };
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">`;
  s += `<defs><clipPath id="cwin"><rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="4"/></clipPath>`;
  s += `<linearGradient id="cshell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a28"/><stop offset=".5" stop-color="#1c1b1a"/><stop offset="1" stop-color="#121211"/></linearGradient>`;
  s += `<linearGradient id="clabel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3ecdb"/><stop offset="1" stop-color="#e4d9c0"/></linearGradient>`;
  s += `<radialGradient id="cpack"><stop offset=".5" stop-color="#6b4a31"/><stop offset=".85" stop-color="#5a3d28"/><stop offset=".97" stop-color="#7a5a3e"/><stop offset="1" stop-color="#2a1c12"/></radialGradient></defs>`;
  s += `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="5" fill="url(#cshell)" stroke="#060606"/>`;
  s += `<rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="4.5" fill="none" stroke="rgba(255,255,255,.07)"/>`;
  for (const [sx, sy] of [
    [6, 6],
    [w - 6, 6],
    [6, h - 6],
    [w - 6, h - 6],
    [w / 2, h - 10],
  ]) {
    s += `<circle cx="${sx}" cy="${sy}" r="1.8" fill="#0b0b0b" stroke="#3a3a3a" stroke-width=".5"/>`;
  }
  // Label, then the window cut through it.
  s += `<rect x="9" y="7" width="${w - 18}" height="66" rx="3" fill="url(#clabel)"/>`;
  s += `<rect x="9" y="12" width="${w - 18}" height="9" fill="#ef6a1e"/>`;
  s += `<text x="16" y="19" font-family="Archivo, sans-serif" font-weight="800" font-stretch="125%" font-size="6.5" letter-spacing="1.6" fill="#fff6ec">EKO</text>`;
  s += `<text x="${w - 16}" y="19" font-family="Archivo, sans-serif" font-weight="700" font-size="5.5" letter-spacing="1" fill="#fff6ec" text-anchor="end">C-60  LOW NOISE</text>`;
  s += `<circle cx="20" cy="29" r="5" fill="none" stroke="#2c2b27" stroke-width=".8"/>`;
  s += `<text x="20" y="31.4" font-family="Archivo, sans-serif" font-weight="800" font-size="7" fill="#2c2b27" text-anchor="middle">A</text>`;
  s += `<line x1="29" y1="31" x2="${w - 14}" y2="31" stroke="#b9ae96" stroke-width=".4"/>`;
  s += `<text class="cassette-title" x="31" y="30" font-family="Caveat, 'Bradley Hand', cursive" font-size="9.5" fill="#1f2a5a"></text>`;
  s += `<rect x="${win.x - 1.5}" y="${win.y - 1.5}" width="${win.w + 3}" height="${win.h + 3}" rx="5" fill="#2a2724"/>`;
  s += `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="4" fill="#0d0c0b"/>`;
  s += `<g clip-path="url(#cwin)">`;
  s += `<circle class="pack" cx="${x1}" cy="${y1}" r="17" fill="url(#cpack)"/>`;
  s += `<circle class="pack" cx="${x2}" cy="${y2}" r="17" fill="url(#cpack)"/>`;
  s += sprocket(x1, y1) + sprocket(x2, y2);
  s += `</g>`;
  s += `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h * 0.45}" rx="4" fill="rgba(255,255,255,.06)"/>`;
  s += `<text x="${w / 2}" y="68" font-family="Archivo, sans-serif" font-weight="600" font-size="4" letter-spacing="1.2" fill="#8f8a80" text-anchor="middle" class="cassette-type"></text>`;
  // The lower lip: head opening and capstan holes.
  s += `<path d="M30 ${h - 1} L38 78 L${w - 38} 78 L${w - 30} ${h - 1}" fill="#161514" stroke="#060606" stroke-width=".6"/>`;
  for (const hx of [48, 66, 82, 98, 116]) {
    s += `<rect x="${hx - 3}" y="${h - 10}" width="6" height="5" rx="1" fill="#050505"/>`;
  }
  s += `<rect x="40" y="${h - 3.5}" width="${w - 80}" height="1.4" fill="#3d2a1c"/>`;
  s += `</svg>`;
  el.innerHTML = s;
  return {
    packs: [...el.querySelectorAll(".pack")],
    hubs: [...el.querySelectorAll(".hub")],
    title: el.querySelector(".cassette-title"),
    type: el.querySelector(".cassette-type"),
  };
}
