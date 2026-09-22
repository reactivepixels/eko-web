/**
 * Deterministic abstract cover art, generated from a track's name.
 *
 * The demo needs something in the cover slot, and a grey square reads as a bug rather
 * than as a design. Real art means shipping image files with a licence to keep straight;
 * drawing it instead means the same title always produces the same cover, every track
 * looks distinct, and there is nothing to license.
 *
 * One composition, in the spirit of the player it sits in: concentric rings around a
 * point, one warm accent arc, a warm ground. Everything is laid out from that point with
 * the outer radius shrunk to match how far it has drifted, so the rings never clip against
 * an edge and the art still reads at 64px.
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

/** A point on a circle around (cx, cy), in SVG coordinates. */
function pointOn(cx, cy, radius, degrees) {
  const rad = (degrees * Math.PI) / 180;
  return `${(cx + radius * Math.cos(rad)).toFixed(2)} ${(cy + radius * Math.sin(rad)).toFixed(2)}`;
}

/** An arc path of `sweep` degrees on `radius`, starting at `from`. */
function arcPath(cx, cy, radius, from, sweep) {
  const large = sweep > 180 ? 1 : 0;
  const a = pointOn(cx, cy, radius, from);
  const b = pointOn(cx, cy, radius, from + sweep);
  return `M${a} A${radius} ${radius} 0 ${large} 1 ${b}`;
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

  // Where the rings are centred. The drift is small and the outer radius shrinks to match,
  // so the outermost ring always lands about 9 units inside the edge.
  const angle = r() * Math.PI * 2;
  const distance = r() * 9;
  const cx = 50 + Math.cos(angle) * distance;
  const cy = 50 + Math.sin(angle) * distance;

  const count = 4 + Math.floor(r() * 3); // 4 to 6
  const inner = 8 + r() * 5;
  const outer = 41 - distance;
  const step = (outer - inner) / (count - 1);

  let motif = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(inner * 0.5).toFixed(1)}" fill="${ink}" fill-opacity="${dark ? 0.14 : 0.17}"/>`;
  for (let i = 0; i < count; i++) {
    motif += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(inner + i * step).toFixed(1)}" fill="none" stroke="${ink}" stroke-opacity="${(inkTop - i * 0.03).toFixed(3)}" stroke-width="1.1"/>`;
  }

  // One accent stroke: the single warm mark the rest of the composition is arranged
  // around. It rides one of the rings, so it belongs to the geometry rather than crossing it.
  const accentRadius = inner + (1 + Math.floor(r() * (count - 1))) * step;
  const from = Math.floor(r() * 360);
  const sweep = 40 + Math.floor(r() * 55);

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
<path d="${arcPath(cx, cy, accentRadius, from, sweep)}" fill="none" stroke="${accent}" stroke-width="2.4" stroke-linecap="round"/>
<rect x="0.5" y="0.5" width="99" height="99" fill="none" stroke="${ink}" stroke-opacity="0.08"/>
</svg>`.replace(/\n/g, "");

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
