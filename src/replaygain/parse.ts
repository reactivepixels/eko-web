import type { ReplayGainTags } from "./types";
import { parseVorbisComments } from "./vorbis";
import { parseId3v2 } from "./id3v2";
import { parseApev2 } from "./apev2";
import { parseMp4 } from "./mp4";

/**
 * Sniffs the container format from magic bytes at the start of `bytes` and dispatches
 * to the one parser (of the four this subpath ships) that understands it. Pure: no
 * IO, no work at import time. `bytes` is expected to be a whole file, or at least its
 * head: a byte range that has no magic at its own start (a Range fetch's TAIL
 * fragment) is a different, fetch-only concern, handled separately by
 * `fetch-range.ts`, which calls the tail-tolerant parsers directly rather than through
 * this function. See that module's comment for why, and `mp4.ts`'s `parseMp4Fragment`
 * for the one parser that needed a fragment-aware counterpart.
 *
 * Recognized magic, in the order checked:
 *   - "fLaC" or "OggS" at offset 0        -> Vorbis comments (FLAC / Ogg Vorbis / Ogg FLAC)
 *   - "ID3" at offset 0                   -> ID3v2 (MP3)
 *   - "APETAGEX" at the footer or header  -> APEv2 (MP3 tail tag)
 *   - "ftyp" at offset 4                  -> MP4/M4A
 *
 * An MP3 can legally carry both an ID3v2 header AND an APEv2 footer at once: neither
 * format precludes the other, and this is a common real-world shape (some taggers
 * write both for compatibility with readers that only understand one). ID3v2 is
 * checked first because it is the FRONT tag and is always what a leading "ID3" magic
 * means; if it parses but carries no ReplayGain frame, APEv2 (the tail tag) is tried
 * next rather than giving up. This order matters and is asserted directly in
 * `read.test.ts`.
 *
 * Returns `{}` for bytes that don't match any recognized magic, and never throws:
 * every parser this dispatches to already guarantees that on its own, and the `catch`
 * below is a second line of defense, not a substitute for it.
 */
export function parseReplayGain(bytes: Uint8Array): ReplayGainTags {
  try {
    if (matchesAt(bytes, 0, FLAC_MAGIC)) return parseVorbisComments(bytes);
    if (matchesAt(bytes, 0, OGG_MAGIC)) return parseVorbisComments(bytes);

    if (matchesAt(bytes, 0, ID3_MAGIC)) {
      const id3Tags = parseId3v2(bytes);
      if (hasTag(id3Tags)) return id3Tags;
      return parseApev2(bytes);
    }

    if (hasApeMagic(bytes)) return parseApev2(bytes);

    if (matchesAt(bytes, 4, FTYP_MAGIC)) return parseMp4(bytes);

    return {};
  } catch {
    return {};
  }
}

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const ID3_MAGIC = [0x49, 0x44, 0x33]; // "ID3"
const APE_MAGIC = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58]; // "APETAGEX"
const APE_BLOCK_SIZE = 32; // the APEv2 header/footer block's fixed size
const FTYP_MAGIC = [0x66, 0x74, 0x79, 0x70]; // "ftyp", at offset 4 in a real MP4/M4A

function matchesAt(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/** True when `bytes` carries an APEv2 magic at either place it can legally appear: the
 * footer (the last 32 bytes of the buffer, where nearly every real tag's authoritative
 * copy lives) or the header (offset 0, the rare header-only shape). Mirrors
 * `apev2.ts`'s own footer-then-header search order, so this sniff and the parser it
 * dispatches to agree on what counts as "present". */
function hasApeMagic(bytes: Uint8Array): boolean {
  return (
    matchesAt(bytes, bytes.length - APE_BLOCK_SIZE, APE_MAGIC) || matchesAt(bytes, 0, APE_MAGIC)
  );
}

/** True once either loudness field is present. Used to decide whether a parser that
 * ran (ID3v2) actually found something, or came back empty and a fallback (APEv2)
 * should be tried instead. */
function hasTag(tags: ReplayGainTags): boolean {
  return tags.gainDb !== undefined || tags.peak !== undefined;
}
