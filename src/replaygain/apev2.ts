import type { ReplayGainTags } from "./types";

/**
 * Reads ReplayGain loudness tags out of an APEv2 tag, the other tagging scheme MP3
 * files use (alongside ID3v2, handled by `id3v2.ts`). Pure byte parsing: no engine
 * dependency, no work performed at import time (this module has no side effects).
 *
 * An APEv2 tag is framed by a 32-byte header and/or footer of identical shape, sitting
 * at the very start and/or very end of the tag's own bytes. Every real-world tag has a
 * footer (many taggers skip the header entirely to save 32 bytes, since the footer
 * alone is authoritative), so the footer is checked first, at the very end of the
 * buffer; the header, at the very start of the buffer, is only a fallback for the rare
 * header-only tag.
 *
 * Every read is bounds-checked against the buffer and against the tag's own declared
 * size. A malformed or truncated tag must never throw: it returns `{}`, or whatever
 * items were already read successfully before truncation cut it off, because a broken
 * tag can never be allowed to take down playback.
 *
 * There is no encoder on the machine this was built on that writes APEv2 tags, so
 * `tests/fixtures/replaygain/build.ts` hand-builds tag bytes from the same reading of
 * the spec this parser is written from, rather than from a captured real file. See
 * that file's module comment, and `tests/replaygain/apev2.test.ts`'s, for what that
 * means for how much this parser can be said to be verified.
 */

const APE_MAGIC = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58]; // "APETAGEX"
const BLOCK_SIZE = 32;
const HEADER_FLAG = 0x80000000; // bit 31 of the flags field: this block IS the header

function matchesAt(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/** Little-endian uint32 read, bounds-checked against `end` (the tag's own declared
 * boundary, not just the physical buffer length, so a field that runs past where the
 * tag itself says it ends is rejected even when the buffer physically has more bytes
 * there). */
function readUint32LE(bytes: Uint8Array, offset: number, end: number): number | undefined {
  if (offset < 0 || offset + 4 > end) return undefined;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/** Parses the leading numeric value out of a ReplayGain value string like "-6.50 dB",
 * ignoring any unit. Returns undefined, not 0, when the string does not parse to a
 * finite number: a silent 0 would read as "no adjustment" and hide a broken tag. */
function parseGainValue(value: string): number | undefined {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(value);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1] as string);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface TagBlock {
  /** The items plus the footer, in bytes, EXCLUDING the header (per spec, this is
   * what the field means whichever of the two copies, header or footer, it's read
   * from). */
  tagSize: number;
  itemCount: number;
  /** True when THIS block's own flags say it is the header (bit 31 set), false when
   * it says it's the footer. Read from the block itself, not inferred from which
   * search (end-of-buffer or start-of-buffer) found it. */
  isHeaderBlock: boolean;
}

/** Reads the 32-byte header/footer block at `offset`, bounds-checked against `end`
 * (the physical buffer length: there's no smaller declared boundary to check a
 * header/footer block itself against). Returns undefined, not a partially-read block,
 * if any field would run past `end`. */
function readTagBlock(bytes: Uint8Array, offset: number, end: number): TagBlock | undefined {
  if (offset < 0 || offset + BLOCK_SIZE > end) return undefined;
  const tagSize = readUint32LE(bytes, offset + 12, end);
  const itemCount = readUint32LE(bytes, offset + 16, end);
  const flags = readUint32LE(bytes, offset + 20, end);
  if (tagSize === undefined || itemCount === undefined || flags === undefined) return undefined;
  return { tagSize, itemCount, isHeaderBlock: (flags & HEADER_FLAG) !== 0 };
}

/** A null-terminated ASCII key is read a byte at a time: APEv2 keys are always plain
 * ASCII, so this never needs a real decoder, just this. */
function readAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** Finds the null terminator following an item's key, starting at `start` and never
 * reading at or past `end` (the tag's own boundary). Returns -1, not a false match
 * past the boundary, when none is found before `end`. */
function findKeyTerminator(bytes: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0x00) return i;
  }
  return -1;
}

/**
 * Reads `itemCount` items starting at `start`, never reading at or past `end` (the
 * items region's own boundary, derived from the tag's declared size). Returns
 * whatever tags were already read before an item's own fields ran past that boundary,
 * rather than discarding them: the same truncation convention `vorbis.ts` and
 * `id3v2.ts` use.
 */
function readItems(
  bytes: Uint8Array,
  start: number,
  itemCount: number,
  end: number,
): ReplayGainTags {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const tags: ReplayGainTags = {};
  let cursor = start;

  for (let i = 0; i < itemCount; i++) {
    const valueSize = readUint32LE(bytes, cursor, end);
    if (valueSize === undefined) return tags;
    cursor += 4;

    // Item flags are read only to bounds-check their 4 bytes; this parser doesn't
    // need the item-type bits (binary vs. UTF-8 text) since it only ever reads the
    // two plain-text ReplayGain keys it's looking for.
    const itemFlags = readUint32LE(bytes, cursor, end);
    if (itemFlags === undefined) return tags;
    cursor += 4;

    const keyEnd = findKeyTerminator(bytes, cursor, end);
    if (keyEnd === -1) return tags;
    const key = readAscii(bytes, cursor, keyEnd).toLowerCase();
    cursor = keyEnd + 1;

    const valueEnd = cursor + valueSize;
    if (valueEnd > end) return tags;
    const value = decoder.decode(bytes.subarray(cursor, valueEnd));
    cursor = valueEnd;

    if (key === "replaygain_track_gain") {
      const gainDb = parseGainValue(value);
      if (gainDb !== undefined) tags.gainDb = gainDb;
    } else if (key === "replaygain_track_peak") {
      const peak = parseGainValue(value);
      if (peak !== undefined) tags.peak = peak;
    }
  }

  return tags;
}

/**
 * Parses ReplayGain track gain/peak out of an APEv2 tag's items. Returns `{}` when
 * neither a footer (at the end of `bytes`) nor a header (at its start) is found, or
 * when the tag's own declared size runs past the buffer: it never throws.
 */
export function parseApev2(bytes: Uint8Array): ReplayGainTags {
  try {
    const end = bytes.length;
    const footerOffset = end - BLOCK_SIZE;

    let offset: number | undefined;
    if (matchesAt(bytes, footerOffset, APE_MAGIC)) {
      offset = footerOffset;
    } else if (matchesAt(bytes, 0, APE_MAGIC)) {
      offset = 0;
    }
    if (offset === undefined) return {};

    const block = readTagBlock(bytes, offset, end);
    if (!block) return {};

    const itemsSize = block.tagSize - BLOCK_SIZE; // tagSize excludes the header, includes the footer
    if (itemsSize < 0) return {};

    // A block whose own flags mark it as the header has its items immediately after
    // it; any other block found here is a footer, whose items sit immediately before
    // it (this holds regardless of which of the two searches above found the block).
    const itemsStart = block.isHeaderBlock ? offset + BLOCK_SIZE : offset - itemsSize;
    if (itemsStart < 0) return {};
    const itemsEnd = itemsStart + itemsSize;
    if (itemsEnd > end) return {};

    return readItems(bytes, itemsStart, block.itemCount, itemsEnd);
  } catch {
    return {};
  }
}
