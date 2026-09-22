/**
 * The demo playlist.
 *
 * Add a track by dropping the file in `examples/shared/media/` and adding an entry below.
 * Every demo reads this one list, so a track added here appears in all three.
 *
 * `id` and `src` are the only fields the library itself reads. Everything else is for the
 * demo's own display and for keeping the licensing honest, which matters because this repo
 * is public: see `examples/shared/media/README.md` for what each field is for and what has
 * to be recorded before a file can ship.
 *
 * An empty list is fine. The demos fall back to a generated test tone, so the page always
 * works even with no audio committed.
 */

/**
 * @typedef {object} DemoTrack
 * @property {string} id       stable id, also used to seed the generated cover art
 * @property {string} src      path relative to the demo page, so `../shared/media/…`
 * @property {string} title    shown as the track name
 * @property {string} artist   shown under it
 * @property {string} license  the exact licence, e.g. "CC BY 4.0" or "CC0 1.0"
 * @property {string} licenseUrl  link to the licence text
 * @property {string} sourceUrl   where the file came from, so the claim can be checked
 * @property {string} [attribution]  the credit line the licence requires, if it requires one
 */

/** @type {DemoTrack[]} */
export const tracks = [
  // Example of a complete entry. Delete this comment when the first real track lands.
  //
  // {
  //   id: "drift",
  //   src: "../shared/media/drift.flac",
  //   title: "Drift",
  //   artist: "Some Artist",
  //   license: "CC BY 4.0",
  //   licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  //   sourceUrl: "https://example.com/the-page-you-got-it-from",
  //   attribution: "Drift by Some Artist, CC BY 4.0",
  // },
];

/** Whether there is anything to preload, or the demos should offer the test tone instead. */
export const hasPreloadedTracks = tracks.length > 0;

/**
 * The credit lines a licence obliges us to show, deduplicated.
 * CC BY and CC BY-SA require attribution; CC0 does not, though crediting anyway is polite.
 */
export function attributionLines() {
  return [...new Set(tracks.map((t) => t.attribution).filter(Boolean))];
}
