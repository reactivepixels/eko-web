/**
 * The library the menus browse. Dropped files only have names (and, when a folder was
 * picked, a path), so artist, album and title are read out of those the way people name
 * their files: "Artist - Title", "Artist - Album - Title", "01 Title", "Work I. Movement".
 */

const UNKNOWN_ARTIST = "Unknown Artist";
const UNKNOWN_ALBUM = "Unknown Album";

/**
 * @param {string} name  a title as titleFromName() gives it (no extension)
 * @param {string} [folder]  the folder the file came from, if known
 */
export function parseTrack(name, folder = "") {
  let rest = name.trim();
  let number = 0;
  const lead = /^(\d{1,3})[\s.\-_)]+(.+)$/.exec(rest);
  if (lead) {
    number = Number(lead[1]);
    rest = lead[2].trim();
  }
  const parts = rest
    .split(/\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  let artist = UNKNOWN_ARTIST;
  let album = "";
  let title = rest;
  if (parts.length >= 3) {
    [artist, album] = parts;
    title = parts.slice(2).join(" - ");
  } else if (parts.length === 2) {
    [artist, title] = parts;
  }
  // "Ember Set I. Glass Dawn": a work and its movement. The movement keeps its own name and
  // the work stands in for the album.
  const movement = /^(.+?)\s+([IVX]{1,5})\.\s+(.+)$/.exec(title);
  if (movement) {
    album ||= movement[1];
    number ||= romanToNumber(movement[2]);
    title = movement[3];
  }
  album ||= folder || UNKNOWN_ALBUM;
  return { artist, album, title, number };
}

export function romanToNumber(roman) {
  const v = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const cur = v[roman[i]];
    const next = v[roman[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/** Sort the way an iPod does: case-insensitive, ignoring a leading "The ". */
export function sortKey(s) {
  return s.replace(/^the\s+/i, "").toLowerCase();
}
const byKey = (a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true });

/**
 * @param {Array<{ title: string, folder?: string }>} entries
 * @returns the songs (each entry plus artist, album, name, number) and the groupings
 */
export function buildLibrary(entries) {
  const songs = entries.map((entry, index) => {
    const meta = parseTrack(entry.title, entry.folder);
    return { ...entry, ...meta, name: meta.title, index };
  });
  const albums = new Map();
  for (const s of songs) {
    if (!albums.has(s.album)) albums.set(s.album, { name: s.album, artist: s.artist, songs: [] });
    albums.get(s.album).songs.push(s);
  }
  for (const a of albums.values()) {
    a.songs.sort((x, y) => x.number - y.number || byKey(x.name, y.name));
  }
  const artists = new Map();
  for (const s of songs) {
    if (!artists.has(s.artist)) artists.set(s.artist, { name: s.artist, songs: [] });
    artists.get(s.artist).songs.push(s);
  }
  return {
    songs: [...songs].sort((a, b) => byKey(a.name, b.name)),
    albums: [...albums.values()].sort((a, b) => byKey(a.name, b.name)),
    artists: [...artists.values()].sort((a, b) => byKey(a.name, b.name)),
  };
}
