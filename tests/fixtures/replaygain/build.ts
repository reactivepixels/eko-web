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

/**
 * Hand-built MP4/M4A atom bytes: just the `moov.udta.meta.ilst` chain that carries
 * ReplayGain freeform tags, not a full playable file (no `ftyp`, no `mdat`; `mp4.ts`
 * only ever walks the `moov` branch, so nothing else is needed to exercise it).
 *
 * There is no encoder available on this machine that writes these tags into an
 * MP4/M4A file: ffmpeg silently drops `-metadata REPLAYGAIN_*` for this container,
 * and AtomicParsley, mp4tags and mid3v2 are all absent. So, like this file's APEv2
 * builder above, this one is built straight from the same reading of the spec that
 * `mp4.ts`'s parser is written from: if that reading is wrong, both sides agree and
 * every test built on it passes anyway. Every field below gets its own commented
 * line so a reviewer who knows the format can check it by eye, and `mp4.test.ts`
 * says the same thing again next to the tests that rely on it.
 *
 * Every atom: 4-byte big-endian size (the WHOLE atom, header included), then a
 * 4-byte ASCII type, then its payload.
 *
 * A ReplayGain tag lives in a freeform `----` atom inside `ilst`, itself three child
 * atoms:
 *   `mean` atom: 4-byte version/flags (zero), then ASCII "com.apple.iTunes"
 *   `name` atom: 4-byte version/flags (zero), then the ASCII key, e.g.
 *                "replaygain_track_gain"
 *   `data` atom: 4-byte type indicator (1 = UTF-8 text), 4-byte locale/country
 *                (zero), then the ASCII value bytes, e.g. "-6.50 dB"
 *
 * `meta` is the one atom in this chain whose payload carries its own 4-byte
 * version/flags field BEFORE its children (`moov`, `udta` and `ilst` do not): that
 * field is written here too, so a parser that fails to skip it misaligns everything
 * that follows.
 */

const MEAN_APPLE_ITUNES = "com.apple.iTunes";
const FREEFORM_TYPE = "----";

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** One atom: 4-byte big-endian size (header + payload), 4-byte ASCII type, payload. */
function atom(type: string, payload: number[]): number[] {
  const size = 8 + payload.length; // header (4-byte size + 4-byte type) + payload
  return [...u32be(size), ...asciiBytes(type), ...payload];
}

/** One freeform `----` item: `mean` ("com.apple.iTunes") + `name` (the key) +
 * `data` (type indicator 1, locale 0, the value bytes), each a full child atom. */
function buildFreeformItem(key: string, value: string): number[] {
  const mean = atom("mean", [
    ...u32be(0), // version/flags: zero
    ...asciiBytes(MEAN_APPLE_ITUNES),
  ]);
  const name = atom("name", [
    ...u32be(0), // version/flags: zero
    ...asciiBytes(key),
  ]);
  const data = atom("data", [
    ...u32be(1), // type indicator: 1 = UTF-8 text
    ...u32be(0), // locale/country: 0
    ...asciiBytes(value), // ReplayGain values are plain ASCII decimals (+ unit)
  ]);
  return atom(FREEFORM_TYPE, [...mean, ...name, ...data]);
}

/**
 * Builds the `moov.udta.meta.ilst` atom chain carrying one freeform `----` item per
 * key/value pair, in insertion order.
 */
export function buildMp4(items: Record<string, string>): Uint8Array {
  const freeformItems = Object.entries(items).flatMap(([key, value]) =>
    buildFreeformItem(key, value),
  );

  const ilst = atom("ilst", freeformItems);
  const meta = atom("meta", [
    ...u32be(0), // meta's own version/flags field, BEFORE its children: the one atom
    // in this chain that has one (moov/udta/ilst do not)
    ...ilst,
  ]);
  const udta = atom("udta", meta);
  const moov = atom("moov", udta);
  return new Uint8Array(moov);
}

/**
 * Hand-built MP4/M4A atom bytes for the OTHER real tag layout: the QuickTime
 * metadata-keys scheme ffmpeg writes (`-movflags use_metadata_tags`), as opposed to
 * the iTunes freeform scheme `buildMp4` above builds. Unlike that one, this layout IS
 * backed by a real encoder's output: `tests/fixtures/replaygain/tone-keys.m4a`, dumped
 * byte-for-byte in `mp4.ts`'s module comment and in `mp4.test.ts`'s keys-scheme
 * `describe` block. This builder exists alongside that real fixture to reach cases the
 * real file can't: a missing/unrecognized handler, a truncated or oversized `keys`
 * entry, an out-of-range `ilst` index, and a file that carries both schemes at once.
 *
 * The three atoms this layout adds inside `meta`, alongside `ilst` (same shape as
 * `buildMp4`'s: still a plain container, no version/flags field of its own):
 *
 *   `hdlr` atom: 4-byte version/flags (zero), 4-byte predefined (zero), 4-byte
 *                handler type ("mdta" for this scheme, "mdir" for the freeform one),
 *                12 bytes reserved (zero), then a single null byte (empty name)
 *   `keys` atom: 4-byte version/flags (zero), 4-byte entry count, then that many
 *                entries back to back:
 *                  4-byte entry size (the WHOLE entry: this field + namespace + name)
 *                  4-byte namespace (always "mdta")
 *                  N bytes key name, filling the entry out to its declared size
 *   `ilst` atom: same container shape as the freeform scheme's `ilst`, but each
 *                child's 4-byte "type" field is instead read as a big-endian integer:
 *                a 1-based index into `keys`'s entry list, joining the value to its
 *                key by position rather than by an embedded name. Each child's payload
 *                is a single `data` atom, byte-identical in shape to the freeform
 *                scheme's: 4-byte type indicator (1 = UTF-8 text), 4-byte
 *                locale/country (zero), then the ASCII value bytes.
 */

const HANDLER_MDTA = "mdta";
const KEYS_NAMESPACE_MDTA = "mdta";

/** One `hdlr` atom declaring the metadata-keys scheme's handler type (or, for a
 * dispatch test, some other 4-byte value in that same slot). */
function buildHdlr(handlerType: string = HANDLER_MDTA): number[] {
  return atom("hdlr", [
    ...u32be(0), // version/flags: zero
    ...u32be(0), // predefined: zero
    ...asciiBytes(handlerType), // handler type
    ...new Array(12).fill(0x00), // reserved
    0x00, // name: empty, null-terminated
  ]);
}

/** One `keys` entry: 4-byte entry size (itself + namespace + name), 4-byte namespace
 * ("mdta"), then the key name filling the rest. */
function buildKeyEntry(name: string): number[] {
  const nameBytes = asciiBytes(name);
  const entrySize = 8 + nameBytes.length; // 4-byte size + 4-byte namespace + name
  return [...u32be(entrySize), ...asciiBytes(KEYS_NAMESPACE_MDTA), ...nameBytes];
}

/** The `keys` atom: 4-byte version/flags (zero), 4-byte entry count, then one
 * `buildKeyEntry` per name, in order (entry N+1 is key index N+1, 1-based). */
function buildKeys(keyNames: string[]): number[] {
  return atom("keys", [
    ...u32be(0), // version/flags: zero
    ...u32be(keyNames.length), // entry count
    ...keyNames.flatMap(buildKeyEntry),
  ]);
}

/** One `ilst` child for the keys scheme: its 4-byte "type" field is `index` itself
 * (big-endian), not an ASCII fourCC, joining it to `keys`'s N-th entry by position. */
function buildKeysIlstEntry(index: number, value: string): number[] {
  const data = atom("data", [
    ...u32be(1), // type indicator: 1 = UTF-8 text
    ...u32be(0), // locale/country: 0
    ...asciiBytes(value),
  ]);
  return [...u32be(8 + data.length), ...u32be(index), ...data]; // "type" is the index
}

/**
 * Builds the `moov.udta.meta.{hdlr,keys,ilst}` atom chain for the QuickTime
 * metadata-keys scheme, one `keys` entry and one `ilst` entry per key/value pair, in
 * insertion order (so the first item is key index 1, the second index 2, and so on).
 *
 * `handlerType` defaults to `"mdta"` (the real value ffmpeg writes); pass another
 * value, or `includeHdlr: false` to omit the atom entirely, to build fixtures for the
 * "missing or unrecognized handler falls back to trying both schemes" dispatch rule.
 * `extraIlstAtoms` appends raw already-encoded atom bytes as further children of
 * `ilst` (e.g. a freeform `----` atom from a hand-built mix), for tests proving an
 * explicit handler type gates which scheme is actually read rather than always trying
 * both.
 */
export function buildMp4Keys(
  items: Record<string, string>,
  options: { handlerType?: string; includeHdlr?: boolean; extraIlstAtoms?: number[] } = {},
): Uint8Array {
  const { handlerType = HANDLER_MDTA, includeHdlr = true, extraIlstAtoms = [] } = options;

  const keyNames = Object.keys(items);
  const ilstEntries = keyNames.flatMap((name, i) =>
    buildKeysIlstEntry(i + 1, items[name] as string),
  );

  const hdlr = includeHdlr ? buildHdlr(handlerType) : [];
  const keys = buildKeys(keyNames);
  const ilst = atom("ilst", [...ilstEntries, ...extraIlstAtoms]);

  const meta = atom("meta", [
    ...u32be(0), // meta's own version/flags field, BEFORE its children
    ...hdlr,
    ...keys,
    ...ilst,
  ]);
  const udta = atom("udta", meta);
  const moov = atom("moov", udta);
  return new Uint8Array(moov);
}
