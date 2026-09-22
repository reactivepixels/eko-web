/**
 * Hand-built APEv2 tag bytes.
 *
 * There is no encoder available on this machine that writes APEv2 tags (checked:
 * ffmpeg, AtomicParsley, mid3v2 all decline). So unlike the FLAC/Ogg/MP3 fixtures
 * elsewhere in this directory, this one is built straight from the spec rather than
 * captured from a real encoder's output. That means `apev2.ts`'s parser and this
 * builder come from the same reading of the spec: if that reading is wrong, both
 * sides agree and every test built on this file passes anyway. Two things push back
 * against that: every field below gets its own commented line so a reviewer who knows
 * the format can check it by eye, and `apev2.test.ts` says the same thing again next
 * to the tests that rely on it.
 *
 * APEv2 header/footer block: 32 bytes, identical shape whether it's the header or the
 * footer copy.
 *   offset  0, 8 bytes   ASCII "APETAGEX"
 *   offset  8, 4 bytes   LE version (2000)
 *   offset 12, 4 bytes   LE tag size: the items plus the footer, EXCLUDING the header
 *   offset 16, 4 bytes   LE item count
 *   offset 20, 4 bytes   LE flags: bit 31 set = this block IS the header (clear on the
 *                        footer copy); bit 29 set = a header is present somewhere in
 *                        this tag (set the same way on both copies when true)
 *   offset 24, 8 bytes   reserved, zero
 *
 * Each item, back to back, item count of them:
 *   4 bytes   LE value size (byte length of the value that follows, no unit/terminator)
 *   4 bytes   LE item flags (0 = UTF-8 text, read/write; the only kind this builds)
 *   N bytes   ASCII key, null-terminated
 *   M bytes   value bytes (UTF-8, exactly `value size` bytes, no terminator of its own)
 */

const APE_MAGIC = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58]; // "APETAGEX"
const APE_VERSION = 2000;
const BLOCK_SIZE = 32;

const HEADER_FLAG = 0x80000000; // bit 31: this specific block is the header
const HAS_HEADER_FLAG = 0x20000000; // bit 29: a header exists somewhere in this tag

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** One item: value size, item flags, null-terminated key, then the raw value bytes. */
function buildItem(key: string, value: string): number[] {
  const valueBytes = asciiBytes(value); // ReplayGain values are plain ASCII decimals
  return [
    ...u32le(valueBytes.length), // value size
    ...u32le(0), // item flags: 0 = UTF-8 text, not read-only
    ...asciiBytes(key),
    0x00, // null terminator on the key
    ...valueBytes,
  ];
}

/** One 32-byte header/footer block. `flags` already carries HEADER_FLAG and/or
 * HAS_HEADER_FLAG as needed; this only lays out the fixed shape around it. */
function buildBlock(tagSize: number, itemCount: number, flags: number): number[] {
  return [
    ...APE_MAGIC,
    ...u32le(APE_VERSION),
    ...u32le(tagSize),
    ...u32le(itemCount),
    ...u32le(flags),
    ...new Array(8).fill(0x00), // reserved
  ];
}

/**
 * Builds a hand-rolled APEv2 tag from a plain key/value map, in item-insertion order.
 *
 * With `footerOnly: true` (the default real-world shape: most APEv2 taggers skip the
 * header to save 32 bytes, since the footer alone is authoritative) the bytes are just
 * `items + footer`. With `footerOnly: false` a header is written too, giving
 * `header + items + footer`, the shape a header-writing encoder produces.
 */
export function buildApev2(
  items: Record<string, string>,
  options: { footerOnly?: boolean } = {},
): Uint8Array {
  const { footerOnly = false } = options;

  const itemBytes: number[] = [];
  let itemCount = 0;
  for (const [key, value] of Object.entries(items)) {
    itemBytes.push(...buildItem(key, value));
    itemCount++;
  }

  const tagSize = itemBytes.length + BLOCK_SIZE; // items + footer, excluding any header
  const footerFlags = footerOnly ? 0 : HAS_HEADER_FLAG; // bit 31 clear: this copy is the footer
  const footer = buildBlock(tagSize, itemCount, footerFlags);

  if (footerOnly) {
    return new Uint8Array([...itemBytes, ...footer]);
  }

  const headerFlags = HEADER_FLAG | HAS_HEADER_FLAG;
  const header = buildBlock(tagSize, itemCount, headerFlags);
  return new Uint8Array([...header, ...itemBytes, ...footer]);
}
