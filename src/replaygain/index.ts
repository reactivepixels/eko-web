/**
 * `@rpxl/eko-web/replaygain`'s public API: read ReplayGain loudness tags from an
 * already-in-memory buffer, or from a URL without downloading the whole file.
 *
 * `ReplayGainTags` is re-exported from here so consumers of this subpath never need
 * to reach into `./types` directly; `types.ts` remains the single declaration (see
 * that file's own comment) that every parser in this directory imports rather than
 * redeclares.
 */
export type { ReplayGainTags } from "./types";
export { parseReplayGain } from "./parse";

import type { ReplayGainTags } from "./types";
import { parseReplayGain } from "./parse";
import { fetchReplayGain } from "./fetch-range";

/**
 * Reads ReplayGain track gain/peak from `src`:
 *   - an `ArrayBuffer`: parsed directly, in memory, with no IO at all.
 *   - a `string` (a URL): fetched over HTTP Range requests via `fetch-range.ts`,
 *     reading only as many bytes as needed rather than the whole file.
 *
 * A missing tag is not an error. This is called on the path to playing a track, so it
 * must never reject: both branches already guarantee that on their own
 * (`parseReplayGain` and `fetchReplayGain` each catch everything they can throw), and
 * the `try`/`catch` here is a second line of defense, not a substitute for either.
 */
export async function readReplayGain(src: string | ArrayBuffer): Promise<ReplayGainTags> {
  try {
    if (typeof src === "string") return await fetchReplayGain(src);
    return parseReplayGain(new Uint8Array(src));
  } catch {
    return {};
  }
}
