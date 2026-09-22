import type { ReplayGainTags } from "./types";
import { parseReplayGain } from "./parse";
import { parseApev2 } from "./apev2";
import { parseMp4Fragment } from "./mp4";

/**
 * Range-aware ReplayGain fetch for a URL: reads just enough of the file over HTTP
 * Range requests to find its ReplayGain tags, without downloading the whole thing.
 *
 * At most two requests:
 *   - a HEAD range, `bytes=0-65535`, covering the front of the file, where Vorbis
 *     comments, ID3v2 and a faststart MP4's `moov` all live;
 *   - if (and only if) that yields no tag, a TAIL range, `bytes=-65536`, covering the
 *     end, where an APEv2 footer or a NON-faststart MP4's `moov` lives instead.
 *
 * Both ranges are generous enough for any normal tag block (real ReplayGain tags are
 * a few hundred bytes at most) while staying small enough to be worth doing instead
 * of downloading the whole file.
 *
 * The tail path is deliberately NOT run through `parseReplayGain`: a tail fragment has
 * no magic at its own start (that's what makes it a tail fragment, not a whole file or
 * a head), so sniffing it would only ever find nothing. Instead the tail bytes go
 * straight to the two parsers built to work from a fragment's END: `parseApev2` (whose
 * footer search already starts from `bytes.length`, with no sniff needed) and MP4's
 * fragment-tolerant `parseMp4Fragment`, which scans for a `moov` atom at any offset
 * rather than assuming one at offset 0. See `mp4.ts`'s module comment on
 * `parseMp4Fragment` for why an ordinary tail Range request needs that: a
 * non-faststart MP4 (a common, not exotic, real-world shape) puts `moov` at the very
 * end of the file, so the tail fragment starts mid-`mdat` with no atom boundary at 0.
 *
 * A missing tag is not an error, and this function is called on the path to playing a
 * track: every failure mode it can hit -- a 416, a network failure, a CORS rejection,
 * a server that ignores Range and returns 200 with the whole body, a file that isn't
 * audio at all -- resolves to `{}` rather than rejecting. It never throws and never
 * returns a rejected promise.
 */

const HEAD_RANGE = "bytes=0-65535";
const TAIL_RANGE = "bytes=-65536";

function hasTag(tags: ReplayGainTags): boolean {
  return tags.gainDb !== undefined || tags.peak !== undefined;
}

interface RangeResult {
  bytes: Uint8Array;
  /** True when the server returned the WHOLE file rather than a partial range (a
   * plain 200, meaning it ignored the `Range` header, or has nothing smaller to send):
   * these bytes are a complete file, not a fragment that might need a follow-up
   * request to reach the rest of it. */
  wholeFile: boolean;
}

/**
 * Issues one Range request and returns its body, or `undefined` for anything that
 * isn't a usable response: a network failure or CORS rejection (both surface to
 * `fetch` as a rejected promise, indistinguishable from here, and handled the same
 * way), a non-2xx status such as 416 Range Not Satisfiable, or a response whose body
 * can't be read. Never throws, and never lets a rejected promise escape.
 */
async function fetchRange(url: string, range: string): Promise<RangeResult | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Range: range } });
  } catch {
    return undefined;
  }

  if (response.status === 206) {
    try {
      return { bytes: new Uint8Array(await response.arrayBuffer()), wholeFile: false };
    } catch {
      return undefined;
    }
  }

  if (response.status === 200) {
    // The server ignored the Range header (or had nothing smaller to send) and
    // returned the whole file: read it as a complete file, not a partial fragment.
    try {
      return { bytes: new Uint8Array(await response.arrayBuffer()), wholeFile: true };
    } catch {
      return undefined;
    }
  }

  // 416 Range Not Satisfiable, or any other non-2xx status: no usable bytes.
  return undefined;
}

/**
 * Reads ReplayGain tags from a TAIL fragment: bytes that may start mid-atom or
 * mid-frame with no container magic of their own. Deliberately does not sniff for one
 * (see this module's own comment above): it tries only the two parsers built to work
 * from a fragment's end.
 */
function parseTailFragment(bytes: Uint8Array): ReplayGainTags {
  const apeTags = parseApev2(bytes);
  if (hasTag(apeTags)) return apeTags;
  return parseMp4Fragment(bytes);
}

/**
 * Fetches just enough of `url` over HTTP Range requests to read its ReplayGain tags.
 * See this module's comment for the two-range strategy and the never-reject
 * guarantee.
 */
export async function fetchReplayGain(url: string): Promise<ReplayGainTags> {
  const head = await fetchRange(url, HEAD_RANGE);
  if (!head) return {};

  const headTags = parseReplayGain(head.bytes);
  if (hasTag(headTags)) return headTags;
  if (head.wholeFile) return {}; // already read everything there is to read

  const tail = await fetchRange(url, TAIL_RANGE);
  if (!tail) return {};

  return parseTailFragment(tail.bytes);
}
