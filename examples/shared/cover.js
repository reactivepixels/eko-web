/**
 * Deterministic abstract cover art, generated from a track's name.
 *
 * The demo needs something in the cover slot, and a grey square reads as a bug rather
 * than as a design. Real art means shipping image files with a licence to keep straight;
 * drawing it instead means the same title always produces the same cover, every track
 * looks distinct, and there is nothing to license.
 *
 * The vocabulary is deliberately narrow, in the spirit of the player it sits in: a warm
 * ground, soft concentric arcs, one accent stroke, a little grain. Restraint rather than
 * generative noise.
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
  // part of the instrument rather than a photo dropped into it.
  const base = dark ? "#2a2e35" : "#e3e0d8";
  const deep = dark ? "#171a1f" : "#cfccc2";
  const hue = Math.floor(r() * 40) - 20; // a small warm/cool drift per track
  const cx = 26 + r() * 48;
  const cy = 26 + r() * 48;
  const tilt = Math.floor(r() * 180);

  // Concentric arcs, thinning outward. The count and spacing vary per track, which is
  // what makes two covers next to each other read as different records.
  const rings = 3 + Math.floor(r() * 4);
  let arcs = "";
  for (let i = 0; i < rings; i++) {
    const rad = 14 + i * (7 + r() * 9);
    const w = (0.9 - i * 0.1).toFixed(2);
    const o = (0.32 - i * 0.035).toFixed(3);
    arcs += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="none" stroke="${dark ? "#fff" : "#2c2b27"}" stroke-opacity="${o}" stroke-width="${w}"/>`;
  }

  // One accent stroke: the single warm mark the rest of the composition is arranged around.
  const ax = 12 + r() * 40;
  const ay = 60 + r() * 26;
  const alen = 22 + r() * 34;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${base}"/><stop offset="1" stop-color="${deep}"/>
</linearGradient>
<radialGradient id="h" cx="${(cx / 100).toFixed(2)}" cy="${(cy / 100).toFixed(2)}" r="0.7">
<stop offset="0" stop-color="${dark ? "#4a5260" : "#fdfcf8"}" stop-opacity="0.55"/>
<stop offset="1" stop-color="${base}" stop-opacity="0"/>
</radialGradient>
<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/><feColorMatrix type="saturate" values="0"/></filter>
</defs>
<rect width="100" height="100" fill="url(#g)"/>
<rect width="100" height="100" fill="url(#h)"/>
<g transform="rotate(${tilt} 50 50)">${arcs}</g>
<rect x="${ax.toFixed(1)}" y="${ay.toFixed(1)}" width="${alen.toFixed(1)}" height="2.2" rx="1.1" fill="${accent}" opacity="0.92"/>
<rect width="100" height="100" filter="url(#n)" opacity="${dark ? 0.05 : 0.07}"/>
<rect width="100" height="100" fill="none" stroke="${dark ? "#fff" : "#2c2b27"}" stroke-opacity="0.07"/>
</svg>`.replace(/\n/g, "");

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
