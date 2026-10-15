/**
 * Album covers, generated: files dropped into a browser carry no artwork the page can read
 * cheaply, so each album gets a printed-sleeve design seeded by its name. Same name, same
 * sleeve, every time.
 */

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PALETTES = [
  { paper: "#e9e7e0", ink: "#2c2b27", hot: "#ef6a1e" },
  { paper: "#1f2a44", ink: "#e9e7e0", hot: "#ffb347" },
  { paper: "#e4e0d2", ink: "#1d3b33", hot: "#2fa48c" },
  { paper: "#2c2b27", ink: "#e9e7e0", hot: "#ef6a1e" },
  { paper: "#efe4cf", ink: "#5a2a1a", hot: "#d9472b" },
  { paper: "#dfe6ea", ink: "#22313f", hot: "#4f93e2" },
];

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** An SVG sleeve, 112 units square, for the Now Playing screen. */
export function coverSvg(album, artist = "") {
  const h = hashString(`${album}|${artist}`);
  const p = PALETTES[h % PALETTES.length];
  const motif = (h >>> 8) % 4;
  const title = esc(album.toUpperCase().slice(0, 22));
  const by = esc(artist.toUpperCase().slice(0, 18));
  let art = "";
  if (motif === 0) {
    // A setting sun over banded water, the concept's own sleeve.
    art = `<circle cx="56" cy="57" r="35" fill="${p.hot}"/>`;
    for (let y = 57; y < 92; y += 7)
      art += `<rect x="0" y="${y}" width="112" height="3" fill="${p.paper}"/>`;
    art += `<rect x="0" y="92" width="112" height="20" fill="${p.ink}"/>`;
  } else if (motif === 1) {
    // Concentric rings, like a record's grooves.
    for (let r = 40; r > 4; r -= 6) {
      art += `<circle cx="56" cy="60" r="${r}" fill="none" stroke="${r === 22 ? p.hot : p.ink}" stroke-width="${r === 22 ? 3 : 1.2}"/>`;
    }
  } else if (motif === 2) {
    // Bars of a spectrum.
    for (let i = 0; i < 12; i++) {
      const bh = 10 + ((h >>> (i % 24)) % 50);
      art += `<rect x="${8 + i * 8}" y="${96 - bh}" width="5" height="${bh}" fill="${i % 4 ? p.ink : p.hot}"/>`;
    }
  } else {
    // A bold diagonal split.
    art = `<path d="M0 112 L112 28 L112 112 Z" fill="${p.hot}"/><circle cx="34" cy="50" r="12" fill="${p.ink}"/>`;
  }
  return `<svg viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<rect width="112" height="112" fill="${p.paper}"/>${art}
<text x="8" y="14" font-family="Archivo, sans-serif" font-weight="800" font-stretch="125%" font-size="8.2" letter-spacing=".3" fill="${motif === 0 ? p.ink : p.ink}">${title}</text>
<text x="8" y="107" font-family="Archivo, sans-serif" font-weight="700" font-stretch="125%" font-size="5.6" letter-spacing="1.6" fill="${motif === 0 ? p.paper : p.ink}">${by}</text>
<text x="104" y="107" text-anchor="end" font-family="Archivo, sans-serif" font-weight="800" font-stretch="125%" font-size="6.5" letter-spacing=".8" fill="${p.hot}">EKO</text>
</svg>`;
}
