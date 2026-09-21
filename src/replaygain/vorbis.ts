/**
 * Reads ReplayGain loudness tags out of Vorbis comments, the tagging scheme shared by
 * FLAC and Ogg Vorbis. Pure byte parsing: no audio decoding, no engine dependency, and
 * no work performed at import time (this module has no side effects).
 *
 * Every read is bounds-checked against the buffer. A malformed or truncated file must
 * never throw: it must return `{}` (or as much as was read before truncation cut it
 * off), because a broken tag can never be allowed to take down playback.
 */

export interface ReplayGainTags {
  gainDb?: number;
  peak?: number;
}

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
// The Vorbis comment packet: packet type 3, then the literal string "vorbis".
const VORBIS_COMMENT_PACKET = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73];
const FLAC_VORBIS_COMMENT_BLOCK_TYPE = 4;

function matchesAt(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/** Finds `needle` anywhere in `bytes`, from `from` onward. */
function findSequence(bytes: Uint8Array, needle: readonly number[], from = 0): number | undefined {
  const last = bytes.length - needle.length;
  for (let i = from; i <= last; i++) {
    if (matchesAt(bytes, i, needle)) return i;
  }
  return undefined;
}

/** Little-endian uint32 read, bounds-checked against `end` (not just the buffer length,
 * so a container block's own declared size can be enforced as well as the buffer). */
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

/** Big-endian uint24 read, used for the FLAC metadata block length. */
function readUint24BE(bytes: Uint8Array, offset: number, end: number): number | undefined {
  if (offset < 0 || offset + 3 > end) return undefined;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) return undefined;
  return (b0 << 16) | (b1 << 8) | b2;
}

/** Parses the leading float out of a ReplayGain value like "-6.50 dB", ignoring the
 * unit. Returns undefined, not 0, when the string does not parse to a finite number:
 * a silent 0 would read as "no adjustment" and hide a broken tag. */
function parseGainValue(value: string): number | undefined {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(value);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1] as string);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads a Vorbis comment block's fields (vendor string, then a count-prefixed list of
 * `KEY=VALUE` entries) starting at `start`, not reading past `end`. `end` is either the
 * FLAC metadata block's own declared boundary, or the length of the de-framed byte
 * stream for a real Ogg Vorbis comment header (see `collectOggPageData`).
 */
function readCommentBlock(bytes: Uint8Array, start: number, end: number): ReplayGainTags {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let cursor = start;

  const vendorLength = readUint32LE(bytes, cursor, end);
  if (vendorLength === undefined) return {};
  cursor += 4;
  if (cursor + vendorLength > end) return {};
  cursor += vendorLength;

  const commentCount = readUint32LE(bytes, cursor, end);
  if (commentCount === undefined) return {};
  cursor += 4;

  const tags: ReplayGainTags = {};
  for (let i = 0; i < commentCount; i++) {
    const length = readUint32LE(bytes, cursor, end);
    if (length === undefined) return tags;
    cursor += 4;
    if (cursor + length > end) return tags;

    const entry = decoder.decode(bytes.subarray(cursor, cursor + length));
    cursor += length;

    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1);

    if (key === "REPLAYGAIN_TRACK_GAIN") {
      const gainDb = parseGainValue(value);
      if (gainDb !== undefined) tags.gainDb = gainDb;
    } else if (key === "REPLAYGAIN_TRACK_PEAK") {
      const peak = parseGainValue(value);
      if (peak !== undefined) tags.peak = peak;
    }
  }
  return tags;
}

function parseFlac(bytes: Uint8Array): ReplayGainTags {
  let offset = FLAC_MAGIC.length;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    if (header === undefined) return {};
    const isLastBlock = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const length = readUint24BE(bytes, offset + 1, bytes.length);
    if (length === undefined) return {};

    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > bytes.length) return {};

    if (blockType === FLAC_VORBIS_COMMENT_BLOCK_TYPE) {
      return readCommentBlock(bytes, bodyStart, bodyEnd);
    }
    if (isLastBlock) return {};
    offset = bodyEnd;
  }
  return {};
}

const OGG_PAGE_HEADER_MIN = 27; // "OggS" + version + type + granule(8) + serial(4) + seq(4) + checksum(4) + segment count

/**
 * Strips Ogg page framing and concatenates the page payloads into one contiguous
 * buffer, so the header packet(s) inside can be read as if the file had never been
 * split into pages. This is deliberately not full Ogg demuxing: it does not track
 * continuation flags, checksums, or multiple logical bitstreams, only concatenates
 * payloads in file order. That is enough for a single-stream audio file's header
 * packets, which is what every real ReplayGain-tagged Ogg file is, but it is why this
 * helper lives here rather than being sold as a general Ogg reader.
 *
 * This exists because an Ogg file's header packets are not guaranteed to land in a
 * single page: this parser's own FLAC-in-Ogg fixture (`tests/fixtures/replaygain/tone.ogg`)
 * splits its VORBIS_COMMENT metadata block across the page boundary between page 0
 * (STREAMINFO) and page 1 (the comment block itself). A raw byte scan across the
 * framed file would land the search on the second page's Ogg header bytes rather than
 * the comment block. De-framing first keeps the rest of the logic identical to a plain
 * FLAC file's block walk.
 */
function collectOggPageData(bytes: Uint8Array): Uint8Array {
  const payloads: Uint8Array[] = [];
  let total = 0;
  let offset = 0;

  while (offset + OGG_PAGE_HEADER_MIN <= bytes.length && matchesAt(bytes, offset, OGG_MAGIC)) {
    const segmentCount = bytes[offset + 26];
    if (segmentCount === undefined) break;

    const segmentTableStart = offset + OGG_PAGE_HEADER_MIN;
    const segmentTableEnd = segmentTableStart + segmentCount;
    if (segmentTableEnd > bytes.length) break;

    let payloadLength = 0;
    let segmentSizesReadable = true;
    for (let i = segmentTableStart; i < segmentTableEnd; i++) {
      const segmentSize = bytes[i];
      if (segmentSize === undefined) {
        segmentSizesReadable = false;
        break;
      }
      payloadLength += segmentSize;
    }
    if (!segmentSizesReadable) break;

    const payloadStart = segmentTableEnd;
    const payloadEnd = payloadStart + payloadLength;
    if (payloadEnd > bytes.length) break;

    payloads.push(bytes.subarray(payloadStart, payloadEnd));
    total += payloadLength;
    offset = payloadEnd;
  }

  const stream = new Uint8Array(total);
  let cursor = 0;
  for (const payload of payloads) {
    stream.set(payload, cursor);
    cursor += payload.length;
  }
  return stream;
}

function parseOgg(bytes: Uint8Array): ReplayGainTags {
  const stream = collectOggPageData(bytes);

  // Ogg FLAC mapping: the native "fLaC" signature and its FLAC metadata blocks
  // (including the VORBIS_COMMENT block, type 4) appear verbatim once de-framed, same
  // as a plain .flac file, just wrapped in Ogg pages instead of a bare byte stream.
  const flacOffset = findSequence(stream, FLAC_MAGIC);
  if (flacOffset !== undefined) return parseFlac(stream.subarray(flacOffset));

  // Real Ogg Vorbis: the comment header is the packet-type-3 "vorbis" packet, followed
  // directly by the same vendor/comment-count/KEY=VALUE layout as the FLAC block.
  const commentOffset = findSequence(stream, VORBIS_COMMENT_PACKET);
  if (commentOffset === undefined) return {};
  return readCommentBlock(stream, commentOffset + VORBIS_COMMENT_PACKET.length, stream.length);
}

/**
 * Parses ReplayGain track gain/peak out of a FLAC or Ogg Vorbis file's Vorbis comments.
 * Returns `{}` for bytes that are not a recognized container, or whose comment block is
 * truncated or otherwise malformed: it never throws.
 */
export function parseVorbisComments(bytes: Uint8Array): ReplayGainTags {
  try {
    if (matchesAt(bytes, 0, FLAC_MAGIC)) return parseFlac(bytes);
    if (matchesAt(bytes, 0, OGG_MAGIC)) return parseOgg(bytes);
    return {};
  } catch {
    return {};
  }
}
