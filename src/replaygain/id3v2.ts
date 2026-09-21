import type { ReplayGainTags } from "./types";

/**
 * Reads ReplayGain loudness tags out of an ID3v2 tag (v2.3 or v2.4), the tagging scheme
 * MP3 uses. Pure byte parsing: no engine dependency, no work performed at import time
 * (this module has no side effects).
 *
 * The header's own 4-byte size field is syncsafe (7 bits per byte) in BOTH v2.3 and
 * v2.4. FRAME sizes are not: v2.4 frame sizes are syncsafe, but v2.3 frame sizes are a
 * plain 32-bit big-endian integer. For a small frame the two readings often agree
 * (only the size field's last byte is nonzero, and both formulas treat that last byte
 * the same way, shift 0), so a parser with the branches swapped can still pass a naive
 * test. The difference only shows up once some earlier byte of the size is nonzero, or
 * (as built for a syncsafe *misread* of a plain big-endian size) once any size byte has
 * bit 7 set, which a correct syncsafe reader masks away. Read the version byte once,
 * up front, and branch on it for every frame size in the tag.
 *
 * Every read is bounds-checked against the buffer and against the tag's own declared
 * size. A malformed or truncated tag must never throw: it returns `{}`, or whatever
 * frames were already read successfully before truncation cut it off, because a broken
 * tag can never be allowed to take down playback.
 */

const ID3_MAGIC = [0x49, 0x44, 0x33]; // "ID3"
const HEADER_SIZE = 10;
const EXTENDED_HEADER_FLAG = 0x40; // bit 6 of the header flags byte

function matchesId3Magic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === ID3_MAGIC[0] &&
    bytes[1] === ID3_MAGIC[1] &&
    bytes[2] === ID3_MAGIC[2]
  );
}

/** Syncsafe 28-bit integer: 4 bytes, 7 significant bits each. Bit 7 of every byte is
 * supposed to always be 0, but this masks it off explicitly rather than trusting that,
 * because a misread plain big-endian size can have bit 7 set and must decode to a
 * (wrong, but bounded) different number instead of a bogus huge one. */
function readSyncsafe32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  return ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
}

/** Plain 32-bit big-endian integer: used for frame sizes in v2.3 only. */
function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** A frame id is 4 ASCII uppercase letters or digits. Anything else at this position
 * means we've run off the end of the real frames and into zero-padding, so the walk
 * stops instead of trying to read a "frame" out of padding bytes. */
function isValidFrameId(bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 4; i++) {
    const b = bytes[offset + i];
    if (b === undefined) return false;
    const isDigit = b >= 0x30 && b <= 0x39;
    const isUpper = b >= 0x41 && b <= 0x5a;
    if (!isDigit && !isUpper) return false;
  }
  return true;
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** ISO-8859-1 (Latin-1) is a direct byte-to-code-point mapping for every one of its 256
 * values, so it never needs an actual decoder, just this. */
function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** Finds the first null-terminator PAIR (two consecutive 0x00 bytes) aligned on an even
 * offset from the start of `body`. UTF-16 code units are 2 bytes, so unlike the
 * single-byte terminator of ISO-8859-1/UTF-8, the terminator here is two bytes, not
 * one: a lone 0x00 can appear as the high byte of an ordinary ASCII character encoded
 * in UTF-16BE and must not be mistaken for the end of the string. */
function findUtf16NullTerminator(body: Uint8Array): number {
  for (let i = 0; i + 1 < body.length; i += 2) {
    if (body[i] === 0x00 && body[i + 1] === 0x00) return i;
  }
  return -1;
}

/** Decodes a UTF-16 byte range for TXXX encodings 0x01 (UTF-16 with a leading BOM,
 * either endianness) and 0x02 (UTF-16BE, no BOM). */
function decodeUtf16(bytes: Uint8Array, encodingByte: 0x01 | 0x02): string {
  if (encodingByte === 0x02) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2));
  }
  // Missing/malformed BOM: fall back to little-endian rather than throwing.
  return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
}

/** Parses the leading numeric value out of a ReplayGain value string like "-6.50 dB",
 * ignoring the unit. Returns undefined, not 0, when the string does not parse to a
 * finite number: a silent 0 would read as "no adjustment" and hide a broken tag. */
function parseGainValue(value: string): number | undefined {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(value);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1] as string);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface TxxxEntry {
  description: string;
  value: string;
}

/**
 * TXXX body: 1 encoding byte, then a terminated description, then the value (which
 * runs to the end of the frame; TXXX has no length prefix or terminator of its own).
 * Encoding 0x00 = ISO-8859-1, 0x01 = UTF-16 with a BOM, 0x02 = UTF-16BE without a BOM,
 * 0x03 = UTF-8. All four are read directly; only 0x00 and 0x03 are exercised by real
 * ID3v2 tags, but the format defines all four and this format's own real fixture is
 * v2.4/UTF-8, so the other three would otherwise go completely untested by a real file.
 */
function readTxxxBody(bytes: Uint8Array, start: number, end: number): TxxxEntry | undefined {
  if (start < 0 || start >= end || end > bytes.length) return undefined;
  const encoding = bytes[start];
  if (encoding === undefined) return undefined;
  const body = bytes.subarray(start + 1, end);

  if (encoding === 0x00 || encoding === 0x03) {
    const terminator = body.indexOf(0x00);
    if (terminator === -1) return undefined;
    const descBytes = body.subarray(0, terminator);
    const valueBytes = body.subarray(terminator + 1);
    const decode =
      encoding === 0x00
        ? decodeLatin1
        : (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
    return { description: decode(descBytes), value: decode(valueBytes) };
  }

  if (encoding === 0x01 || encoding === 0x02) {
    const terminator = findUtf16NullTerminator(body);
    if (terminator === -1) return undefined;
    const descBytes = body.subarray(0, terminator);
    const valueBytes = body.subarray(terminator + 2);
    return {
      description: decodeUtf16(descBytes, encoding),
      value: decodeUtf16(valueBytes, encoding),
    };
  }

  return undefined;
}

/**
 * Parses ReplayGain track gain/peak out of an ID3v2.3 or ID3v2.4 tag's TXXX frames.
 * Returns `{}` for bytes that don't start with the ID3 magic, or whose header declares
 * a size past the end of the buffer: it never throws. A frame whose own declared size
 * runs past the tag returns whatever tags were already read from earlier frames,
 * rather than discarding them.
 */
export function parseId3v2(bytes: Uint8Array): ReplayGainTags {
  try {
    if (!matchesId3Magic(bytes)) return {};

    const version = bytes[3];
    const flags = bytes[5];
    if (version === undefined || flags === undefined) return {};

    const declaredSize = readSyncsafe32(bytes, 6);
    if (declaredSize === undefined) return {};

    const tagEnd = HEADER_SIZE + declaredSize;
    if (tagEnd > bytes.length) return {};

    let cursor = HEADER_SIZE;

    if ((flags & EXTENDED_HEADER_FLAG) !== 0) {
      if (version >= 4) {
        // v2.4: the extended header's own size field is syncsafe and INCLUDES those 4
        // size bytes, so the field alone tells us how far to skip.
        const extSize = readSyncsafe32(bytes, cursor);
        if (extSize === undefined || cursor + extSize > tagEnd) return {};
        cursor += extSize;
      } else {
        // v2.3: the extended header's size field is a plain 32-bit value that does NOT
        // include the 4 size bytes themselves, so skip those separately.
        const extSize = readUint32BE(bytes, cursor);
        if (extSize === undefined || cursor + 4 + extSize > tagEnd) return {};
        cursor += 4 + extSize;
      }
    }

    const tags: ReplayGainTags = {};

    while (cursor + 10 <= tagEnd) {
      if (!isValidFrameId(bytes, cursor)) break; // padding reached, not a real frame

      const frameId = readAscii(bytes, cursor, cursor + 4);
      const frameSize =
        version >= 4 ? readSyncsafe32(bytes, cursor + 4) : readUint32BE(bytes, cursor + 4);
      if (frameSize === undefined) return tags;

      const frameBodyStart = cursor + 10;
      const frameBodyEnd = frameBodyStart + frameSize;
      if (frameBodyEnd > tagEnd) return tags;

      if (frameId === "TXXX") {
        const entry = readTxxxBody(bytes, frameBodyStart, frameBodyEnd);
        if (entry) {
          const key = entry.description.toLowerCase();
          if (key === "replaygain_track_gain") {
            const gainDb = parseGainValue(entry.value);
            if (gainDb !== undefined) tags.gainDb = gainDb;
          } else if (key === "replaygain_track_peak") {
            const peak = parseGainValue(entry.value);
            if (peak !== undefined) tags.peak = peak;
          }
        }
      }

      cursor = frameBodyEnd;
    }

    return tags;
  } catch {
    return {};
  }
}
