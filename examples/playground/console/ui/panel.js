/**
 * Builds the console's face from the approved concept, in design units, and returns the
 * live parts: every knob, fader, key and lamp the page needs to wire up or redraw.
 */
import { STEMS } from "../audio/stems.js";
import { STEPS, VOICE_NAMES, VOICES } from "../audio/sequencer.js";

const el = (parent, html) => {
  parent.insertAdjacentHTML("beforeend", html);
  return parent.lastElementChild;
};

const LIGHT_CAPS = ["#e9e2d0", "#c9c4b8", "#f0c94a"];

/** A knob with its printed tick ring and legend. Returns the knob element (the slider). */
function knob(parent, x, y, size, cap, label, { labelDy = 0, ticks = 11, span = 135, id } = {}) {
  const w = size + 16;
  const c = w / 2;
  let svg = `<svg class="ticks" style="left:${x}px;top:${y}px" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" aria-hidden="true">`;
  for (let i = 0; i < ticks; i++) {
    const a = ((-span + (2 * span * i) / (ticks - 1)) * Math.PI) / 180;
    const big = i === 0 || i === ticks - 1 || i === (ticks - 1) / 2;
    const r1 = c - (big ? 6.5 : 5.5);
    const r2 = c - 2;
    svg += `<line x1="${c + Math.sin(a) * r1}" y1="${c - Math.cos(a) * r1}" x2="${c + Math.sin(a) * r2}" y2="${c - Math.cos(a) * r2}" stroke="#d9d4c8" stroke-width="${big ? 1 : 0.7}" stroke-opacity="${big ? 0.8 : 0.45}"/>`;
  }
  el(parent, `${svg}</svg>`);
  const ind = LIGHT_CAPS.includes(cap) ? "#1d1b18" : "#f4f1e8";
  const k = el(
    parent,
    `<div class="knob" ${id ? `data-ctl="${id}"` : ""} style="left:${x}px;top:${y}px;width:${size}px;height:${size}px;--cap:${cap};--ind:${ind}"><div class="cap"></div><div class="ind"></div></div>`,
  );
  if (label)
    el(
      parent,
      `<div class="lg c" style="left:${x}px;top:${y + size / 2 + 8 + labelDy}px">${label}</div>`,
    );
  k.dataset.span = String(span);
  return k;
}

/* Seven-segment digits for the tempo readout. */
const SEG = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
  "-": "g",
  " ": "",
};
export function sevenSeg(chars, w = 150, h = 62, dot = 2) {
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  const dw = 30;
  const dh = 46;
  const gap = 9;
  const x0 = 12;
  const y0 = (h - dh) / 2;
  const t = 6;
  [...chars].forEach((ch, i) => {
    const x = x0 + i * (dw + gap);
    const segs = {
      a: [x + 3, y0, dw - 6, t],
      d: [x + 3, y0 + dh - t, dw - 6, t],
      g: [x + 3, y0 + dh / 2 - t / 2, dw - 6, t],
      f: [x, y0 + 3, t, dh / 2 - 4],
      b: [x + dw - t, y0 + 3, t, dh / 2 - 4],
      e: [x, y0 + dh / 2 + 1, t, dh / 2 - 4],
      c: [x + dw - t, y0 + dh / 2 + 1, t, dh / 2 - 4],
    };
    const on = SEG[ch] ?? "";
    for (const [k, [sx, sy, sw, sh]] of Object.entries(segs)) {
      const lit = on.includes(k);
      s += `<rect x="${sx + 1.5}" y="${sy}" width="${sw}" height="${sh}" rx="2" transform="skewX(-7)" fill="${lit ? "#ff3d1c" : "rgba(255,61,28,.09)"}" ${lit ? 'filter="url(#glow)"' : ""}/>`;
    }
    if (i === dot)
      s += `<circle cx="${x + dw + 3}" cy="${y0 + dh - 3}" r="3" fill="#ff3d1c" filter="url(#glow)"/>`;
  });
  return `${s}</svg>`;
}

/* The master VU faces, as on the hi-fi. Returns the needle group. */
export const VU = { cx: 56, cy: 98 };
function vuFace(node, side) {
  const W = 112;
  const H = 72;
  const { cx: CX, cy: CY } = VU;
  const lin = (d) => Math.pow(10, d / 20);
  const L0 = lin(-20);
  const L3 = lin(3);
  const ang = (d) => -36 + (72 * (lin(d) - L0)) / (L3 - L0);
  const pol = (a, r) => [
    CX + Math.sin((a * Math.PI) / 180) * r,
    CY - Math.cos((a * Math.PI) / 180) * r,
  ];
  const arc = (a1, a2, r) => {
    const p1 = pol(a1, r);
    const p2 = pol(a2, r);
    return `M${p1[0]} ${p1[1]} A${r} ${r} 0 0 1 ${p2[0]} ${p2[1]}`;
  };
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs><radialGradient id="p${side}" cx="50%" cy="95%" r="95%"><stop offset="0" stop-color="#ffe2a6"/><stop offset=".5" stop-color="#f5c46f"/><stop offset=".85" stop-color="#d88e33"/><stop offset="1" stop-color="#9c5714"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#p${side})"/>`;
  s += `<path d="${arc(ang(-20), ang(0), 68)}" fill="none" stroke="#24180c" stroke-width=".8"/><path d="${arc(ang(0), ang(3), 69.5)}" fill="none" stroke="#c4200f" stroke-width="3.2"/>`;
  for (const d of [-20, -10, -7, -5, -3, 0, 3]) {
    const a = ang(d);
    const p1 = pol(a, 68);
    const p2 = pol(a, 74);
    const lp = pol(a, 80);
    const label = d > 0 ? `+${d}` : d === 0 ? "0" : String(-d);
    s += `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${d > 0 ? "#c4200f" : "#24180c"}" stroke-width="1"/><text x="${lp[0]}" y="${lp[1] + 2}" font-size="5.5" font-family="Archivo" font-weight="700" text-anchor="middle" fill="${d >= 0 ? "#c4200f" : "#24180c"}">${label}</text>`;
  }
  s += `<text x="${CX}" y="56" font-size="10" font-family="Archivo" font-weight="800" text-anchor="middle" fill="#24180c" letter-spacing="1">VU</text><text x="6" y="68" font-size="4" font-family="Archivo" font-weight="700" fill="#3a2a16" letter-spacing="1">${side === "L" ? "LEFT" : "RIGHT"}</text>`;
  s += `<g class="needle" transform="rotate(-40 ${CX} ${CY})"><line x1="${CX + 1.2}" y1="${CY}" x2="${CX + 1.2}" y2="${CY - 76}" stroke="rgba(60,25,0,.22)" stroke-width="1.4"/><line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - 78}" stroke="#14100b" stroke-width=".9"/></g><path d="M24 72 Q56 54 88 72 Z" fill="#111"/></svg>`;
  node.innerHTML = s;
  return node.querySelector(".needle");
}

function fader(parent, x, top, h, line, label) {
  el(parent, `<div class="slot" style="left:${x - 2.5}px;top:${top}px;height:${h}px"></div>`);
  const f = el(
    parent,
    `<div class="fader" style="left:${x}px;top:${top - 23}px;height:${h + 46}px"><div class="ftrack"></div><div class="fcap" style="left:50%;--line:${line}"></div></div>`,
  );
  f.setAttribute("aria-label", label);
  return f;
}

export const CHANNELS = [
  { id: "bd", name: "Kick", group: "rhythm" },
  { id: "cp", name: "Clap", group: "rhythm" },
  { id: "hat", name: "Hats", group: "rhythm" },
  { id: "bass", name: "Bass", group: "rhythm" },
  ...STEMS.map((s) => ({ id: s.id, name: s.name, group: "stems" })),
];

export function buildPanel(face) {
  const rhythm = face.querySelector(".rhythm");
  const parts = { knobs: {}, pads: {}, strips: [], patterns: {} };

  /* rhythm composer */
  el(rhythm, `<div class="brand" style="left:30px;top:30px;font-size:26px">EKO</div>`);
  el(
    rhythm,
    `<div class="lg" style="left:31px;top:64px;font-size:8px;letter-spacing:2px">Rhythm Composer</div>`,
  );
  el(
    rhythm,
    `<div class="lg" style="left:31px;top:77px;font-size:12px;color:#fff;letter-spacing:2px;font-weight:800">NB-124</div>`,
  );
  el(
    rhythm,
    `<div class="lg dim" style="left:31px;top:94px;font-size:6px">Night Bus Console</div>`,
  );
  parts.display = el(
    rhythm,
    `<div class="display" style="left:30px;top:118px;width:150px;height:62px" role="img" aria-label="Tempo"></div>`,
  );
  el(rhythm, `<div class="lg dim" style="left:31px;top:188px">Tempo BPM</div>`);
  parts.knobs.tempo = knob(rhythm, 222, 150, 46, "#c9c4b8", "Tempo", { ticks: 21, span: 140 });
  parts.start = el(
    rhythm,
    `<button class="btn" style="left:30px;top:212px;width:72px;height:30px;--cap:#ef6a1e;--glow:rgba(239,106,30,.55)"><b>START</b></button>`,
  );
  parts.stop = el(
    rhythm,
    `<button class="btn" style="left:110px;top:212px;width:72px;height:30px;--cap:#d9d4c8"><b>STOP</b></button>`,
  );
  parts.knobs.swing = knob(rhythm, 222, 226, 26, "#8f8a80", "Swing", { labelDy: -2 });

  const gx = 322;
  const gy = 30;
  const pw = 38;
  const ph = 33;
  const cgap = 4;
  const ggap = 10;
  const rgap = 9;
  const colX = (i) => gx + i * (pw + cgap) + Math.floor(i / 4) * ggap;
  parts.cursor = el(
    rhythm,
    `<div class="col-cur" style="left:${colX(0) - 3}px;top:${gy - 5}px;height:${VOICES.length * (ph + rgap) + 1}px;opacity:0"></div>`,
  );
  parts.colX = (i) => colX(i) - 3;
  VOICES.forEach((voice, r) => {
    const y = gy + r * (ph + rgap);
    const [w1, w2] = VOICE_NAMES[voice].split(" ");
    el(
      rhythm,
      `<div class="lg" style="left:${gx - 64}px;top:${y + 9}px;font-size:7px">${w1}</div>`,
    );
    el(
      rhythm,
      `<div class="lg dim" style="left:${gx - 64}px;top:${y + 20}px;font-size:6px">${w2}</div>`,
    );
    parts.pads[voice] = [];
    for (let i = 0; i < STEPS; i++) {
      const b = el(
        rhythm,
        `<button class="pad" style="left:${colX(i)}px;top:${y}px" aria-label="${VOICE_NAMES[voice]}, step ${i + 1}"><i></i><b></b></button>`,
      );
      b.dataset.voice = voice;
      b.dataset.step = String(i);
      parts.pads[voice].push(b);
    }
  });
  const CAPS = ["#d9452b", "#e8862a", "#f0c94a", "#e9e2d0"];
  const by = gy + VOICES.length * (ph + rgap) + 1;
  for (let g = 0; g < 4; g++) {
    el(
      rhythm,
      `<div class="band" style="left:${colX(g * 4)}px;top:${by}px;width:${4 * pw + 3 * cgap}px;--cap:${CAPS[g]}"></div>`,
    );
  }
  for (let i = 0; i < STEPS; i++) {
    el(
      rhythm,
      `<div class="lg c dim" style="left:${colX(i) + pw / 2}px;top:${by + 9}px;font-size:6.5px">${i + 1}</div>`,
    );
  }

  const rx = colX(15) + pw + 34;
  el(rhythm, `<div class="vrule" style="left:${rx - 18}px;top:22px;height:218px"></div>`);
  el(rhythm, `<div class="lg" style="left:${rx}px;top:30px">Pattern</div>`);
  ["A", "B", "C", "D"].forEach((p, i) => {
    parts.patterns[p] = el(
      rhythm,
      `<button class="btn" style="left:${rx + i * 30}px;top:44px;width:24px;height:20px;--cap:#d9d4c8;--glow:rgba(240,201,74,.5)" aria-label="Pattern ${p}"><b>${p}</b></button>`,
    );
  });
  el(rhythm, `<div class="lg" style="left:${rx}px;top:84px">Bass Synth</div>`);
  parts.knobs.cutoff = knob(rhythm, rx + 18, 118, 28, "#5c8fd6", "Cutoff");
  parts.knobs.reso = knob(rhythm, rx + 78, 118, 28, "#5c8fd6", "Reso");
  parts.knobs.decay = knob(rhythm, rx + 138, 118, 28, "#5c8fd6", "Decay");
  el(rhythm, `<div class="lg" style="left:${rx}px;top:166px">Kit</div>`);
  parts.knobs.bdTune = knob(rhythm, rx + 18, 198, 28, "#d9452b", "BD Tune");
  parts.knobs.bdDecay = knob(rhythm, rx + 78, 198, 28, "#d9452b", "BD Decay");
  parts.knobs.hatDecay = knob(rhythm, rx + 138, 198, 28, "#f0c94a", "Hat Decay");

  /* mixer */
  const sx = 26;
  const sw = 104;
  el(
    face,
    `<div class="group" style="left:${sx + 10}px;top:276px;width:${4 * sw - 20}px;--gc:#ef6a1e">Rhythm Composer</div>`,
  );
  el(
    face,
    `<div class="group" style="left:${sx + 4 * sw + 10}px;top:276px;width:${4 * sw - 20}px;--gc:#5c8fd6">Stems · EKO engine</div>`,
  );
  CHANNELS.forEach((ch, i) => {
    const x = sx + i * sw;
    const s = el(
      face,
      `<div class="strip" style="left:${x}px" role="group" aria-label="Channel ${i + 1}, ${ch.name}"></div>`,
    );
    if (i) el(face, `<div class="vrule" style="left:${x}px;top:296px;height:500px"></div>`);
    const cx = sw / 2;
    const strip = {
      trim: knob(s, cx, 46, 24, "#8f8a80", "Trim", { labelDy: -3 }),
      hi: knob(s, cx - 21, 94, 22, "#5c8fd6", "Hi", { labelDy: -3 }),
      mid: knob(s, cx + 21, 94, 22, "#6fb35a", "Mid", { labelDy: -3 }),
      lo: knob(s, cx - 21, 142, 22, "#d9452b", "Lo", { labelDy: -3 }),
      echo: knob(s, cx + 21, 142, 22, "#ef6a1e", "Echo", { labelDy: -3 }),
      pan: knob(s, cx, 190, 22, "#e9e2d0", "Pan", { labelDy: -3 }),
    };
    strip.mute = el(
      s,
      `<button class="btn" style="left:${cx - 38}px;top:226px;width:34px;height:20px;--cap:#bdb7aa;--glow:rgba(255,74,42,.55)" aria-label="Mute ${ch.name}"><b>MUTE</b></button>`,
    );
    strip.solo = el(
      s,
      `<button class="btn" style="left:${cx + 4}px;top:226px;width:34px;height:20px;--cap:#bdb7aa;--glow:rgba(240,201,74,.55)" aria-label="Solo ${ch.name}"><b>SOLO</b></button>`,
    );
    el(
      s,
      `<div class="scribble" style="top:258px;--t:${[-1.2, 0.8, -0.4, 1, -0.8, 0.5, -1, 0.6][i]}deg">${ch.name}</div>`,
    );
    const top = 296;
    const h = 190;
    for (const [k, db] of [10, 5, 0, -5, -10, -20, -30, -40].entries()) {
      const y = top + 10 + k * ((h - 20) / 7);
      el(
        s,
        `<div class="fscale" style="left:${cx - 18}px;top:${y}px;width:${db === 0 ? 12 : 8}px;opacity:${db === 0 ? 0.8 : 0.5}"></div>`,
      );
      el(
        s,
        `<div class="lg dim" style="left:${cx - 34}px;top:${y - 3}px;font-size:5.5px;width:14px;text-align:right">${db > 0 ? `+${db}` : db}</div>`,
      );
    }
    const m = el(
      s,
      `<div class="meter" style="left:${cx + 16}px;top:${top}px;height:${h}px" aria-hidden="true"></div>`,
    );
    const N = 22;
    strip.leds = [];
    for (let k = 0; k < N; k++) {
      const cls = k >= N - 3 ? "r" : k >= N - 7 ? "y" : "g";
      strip.leds.push(el(m, `<i class="${cls}" style="top:${h - (k + 1) * (h / N) + 2}px"></i>`));
    }
    strip.fader = fader(
      s,
      cx,
      top,
      h,
      ch.group === "rhythm" ? "#ef6a1e" : "#f1ece2",
      `${ch.name} fader`,
    );
    el(s, `<div class="num" style="top:${top + h + 26}px">${i + 1}</div>`);
    parts.strips.push(strip);
  });

  /* master */
  const mx = sx + 8 * sw;
  el(face, `<div class="vrule" style="left:${mx}px;top:270px;height:530px"></div>`);
  el(
    face,
    `<div class="group" style="left:${mx + 18}px;top:276px;width:250px;--gc:#d9d4c8">Master · Tape Echo</div>`,
  );
  const vu = el(
    face,
    `<div class="vuwin" style="left:${mx + 20}px;top:306px;width:248px;height:84px"><div class="vu" style="left:6px"></div><div class="vu" style="right:6px"></div><div class="glass"></div></div>`,
  );
  parts.needles = [...vu.querySelectorAll(".vu")].map((n, i) => vuFace(n, i ? "R" : "L"));
  el(face, `<div class="lg dim" style="left:${mx + 20}px;top:398px">Output Level</div>`);
  parts.knobs.echoTime = knob(face, mx + 50, 446, 32, "#ef6a1e", "Time");
  parts.knobs.echoRepeat = knob(face, mx + 110, 446, 32, "#ef6a1e", "Repeat");
  parts.knobs.echoTone = knob(face, mx + 170, 446, 32, "#ef6a1e", "Tone");
  parts.knobs.echoReturn = knob(face, mx + 230, 446, 32, "#ef6a1e", "Return");
  parts.sync = el(
    face,
    `<button class="btn" style="left:${mx + 20}px;top:494px;width:56px;height:20px;--cap:#ef6a1e;--glow:rgba(239,106,30,.5)"><b>SYNC</b></button>`,
  );
  parts.syncNote = el(
    face,
    `<div class="lg dim" style="left:${mx + 84}px;top:501px;font-size:6px">Echo locks to tempo · 1/8 dotted</div>`,
  );
  const mt = 540;
  const mh = 200;
  parts.master = fader(face, mx + 142, mt, mh, "#ef6a1e", "Master fader");
  el(
    face,
    `<div class="lg c" style="left:${mx + 142}px;top:${mt + mh + 30}px;font-size:8px;letter-spacing:2px">Master</div>`,
  );
  for (const [k, db] of [10, 5, 0, -5, -10, -20, -30, -40].entries()) {
    const y = mt + 10 + k * ((mh - 20) / 7);
    el(
      face,
      `<div class="fscale" style="left:${mx + 112}px;top:${y}px;width:12px;opacity:${db === 0 ? 0.8 : 0.45}"></div>`,
    );
    el(
      face,
      `<div class="fscale" style="left:${mx + 160}px;top:${y}px;width:12px;opacity:${db === 0 ? 0.8 : 0.45}"></div>`,
    );
    el(
      face,
      `<div class="lg dim" style="left:${mx + 90}px;top:${y - 3}px;font-size:5.5px;width:18px;text-align:right">${db > 0 ? `+${db}` : db}</div>`,
    );
  }
  el(
    face,
    `<div class="brand" style="left:${mx + 200}px;top:${mt + 20}px;font-size:15px">EKO</div>`,
  );
  el(
    face,
    `<div class="lg dim" style="left:${mx + 200}px;top:${mt + 42}px;font-size:6px;line-height:1.6">Web Audio<br>Console<br>8 x 2</div>`,
  );
  parts.hint = el(
    face,
    `<div class="hint" style="left:${mx + 200}px;top:${mt + 100}px;width:70px">Space<br>start / stop<br><br>A B C D<br>pattern</div>`,
  );
  return parts;
}
