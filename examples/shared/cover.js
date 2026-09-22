/**
 * Deterministic abstract cover art, generated from a track's name.
 *
 * The demo needs something in the cover slot, and a grey square reads as a bug rather
 * than as a design. Real art means shipping image files with a licence to keep straight;
 * drawing it instead means the same title always produces the same cover, every track
 * looks distinct, and there is nothing to license.
 *
 * One composition, in the spirit of the player it sits in: a frozen frame of its LED
 * spectrum. A full grid of segments fills the square edge to edge with an equal margin, so
 * there is no single point for the eye to find off centre. The title decides which
 * segments are lit, shaped as a smooth curve so it reads as a spectrum rather than noise,
 * and one warm segment marks the peak.
 */

/** A small, stable string hash, so the same title always draws the same cover. */
function seedFrom(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG, so a cover never changes between reloads. */
function rng(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/**
 * @param {string} title  the track name, used as the seed
 * @param {{dark?: boolean, accent?: string}} [opts]
 * @returns {string} an SVG data URI, ready for an <img src> or a CSS background
 */
export function coverFor(title, opts = {}) {
  const dark = !!opts.dark;
  const accent = opts.accent || "#ef6a1e";
  const r = rng(seedFrom(title || "untitled"));

  // Two warm greys that sit either side of the card's own surface, so the art reads as
  // part of the instrument rather than a photo dropped into it. The pair drifts a little
  // per track, which is what stops a row of covers looking like one repeated tile.
  const drift = Math.round(r() * 14) - 7;
  const tone = (channels) =>
    `rgb(${channels.map((c) => Math.max(0, Math.min(255, c + drift))).join(",")})`;
  const base = dark ? tone([42, 46, 53]) : tone([227, 224, 216]);
  const deep = dark ? tone([23, 26, 31]) : tone([207, 204, 194]);
  const ink = dark ? "#ffffff" : "#2c2b27";
  // Dark ink on a pale ground carries further than white on charcoal, but not at 64px:
  // the light covers need a little more weight to read at all.
  const inkTop = dark ? 0.3 : 0.36;
  const lift = dark ? "#4a5260" : "#fdfcf8";

  // The grid: equal margin on every side, equal gaps between columns and between rows.
  const cols = 9;
  const rows = 9;
  const margin = 14;
  const gap = 2.2;
  const span = 100 - margin * 2;
  const cellW = (span - gap * (cols - 1)) / cols;
  const cellH = (span - gap * (rows - 1)) / rows;

  // Two seeded sine waves summed into one smooth curve, so neighbouring columns relate the
  // way a real spectrum's bands do. Each column lights at least two segments, and never
  // the full height, so every cover has both a shape and some headroom above it.
  const f1 = 0.5 + r() * 0.9;
  const f2 = 1.4 + r() * 1.6;
  const p1 = r() * Math.PI * 2;
  const p2 = r() * Math.PI * 2;
  const heights = [];
  for (let c = 0; c < cols; c++) {
    const x = c / (cols - 1);
    const v = 0.55 + 0.3 * Math.sin(x * Math.PI * f1 + p1) + 0.15 * Math.sin(x * Math.PI * f2 + p2);
    heights.push(Math.max(2, Math.min(rows - 1, Math.round(v * (rows - 1)))));
  }
  const peakCol = heights.indexOf(Math.max(...heights));

  let motif = "";
  for (let c = 0; c < cols; c++) {
    const x = margin + c * (cellW + gap);
    for (let i = 0; i < rows; i++) {
      // Row 0 is the bottom segment.
      const y = margin + (rows - 1 - i) * (cellH + gap);
      const lit = i < heights[c];
      const isPeak = c === peakCol && i === heights[c] - 1;
      const fill = isPeak ? accent : ink;
      // Lit segments fade a little towards the top, like the live display's falloff.
      const opacity = isPeak
        ? 1
        : lit
          ? (inkTop + 0.1 - (i / rows) * 0.12).toFixed(3)
          : dark
            ? 0.06
            : 0.07;
      motif += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellW.toFixed(2)}" height="${cellH.toFixed(2)}" rx="0.8" fill="${fill}" fill-opacity="${opacity}"/>`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${base}"/><stop offset="1" stop-color="${deep}"/>
</linearGradient>
<radialGradient id="h" cx="0.26" cy="0.2" r="0.78">
<stop offset="0" stop-color="${lift}" stop-opacity="0.5"/>
<stop offset="1" stop-color="${base}" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="100" height="100" fill="url(#g)"/>
<rect width="100" height="100" fill="url(#h)"/>
${motif}
<rect x="0.5" y="0.5" width="99" height="99" fill="none" stroke="${ink}" stroke-opacity="0.08"/>
</svg>`.replace(/\n/g, "");

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
