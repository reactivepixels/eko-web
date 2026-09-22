import type { ReplayGainTags } from "./types";

/**
 * Reads ReplayGain loudness tags out of an MP4/M4A file's `moov.udta.meta.ilst`, which
 * real files carry in either of two unrelated layouts. Pure byte parsing: no engine
 * dependency, no work performed at import time (this module has no side effects).
 *
 * MP4 is nested atoms: each one is a 4-byte big-endian size (the WHOLE atom, header
 * included), a 4-byte ASCII type, then a payload.
 *
 * **The iTunes freeform scheme** (what foobar2000 and most taggers write): each
 * `ilst` child is a freeform atom typed `----`, whose payload is itself three child
 * atoms: `mean` ("com.apple.iTunes", identifying the freeform namespace), `name` (the
 * key, e.g. "replaygain_track_gain") and `data` (a 4-byte type indicator, a 4-byte
 * locale, then the value bytes). The key and the value live together in one atom.
 *
 * **The QuickTime metadata-keys scheme** (what ffmpeg writes, e.g. with
 * `-movflags use_metadata_tags`): the key and the value live in two DIFFERENT atoms,
 * joined by position rather than by name. `keys`, a sibling of `ilst` under `meta`,
 * lists key NAMES in order; each `ilst` child's own 4-byte "type" field is not an
 * ASCII fourCC here but a 1-based big-endian INDEX into that `keys` list, and its
 * payload is a single `data` atom in the exact same shape as the freeform scheme's.
 * `meta`'s `hdlr` atom's handler type tells the two apart: `mdta` means this scheme,
 * `mdir` means the freeform one. When `hdlr` is missing or its handler type is
 * neither, both schemes are tried (see `parseMp4`).
 *
 * Four traps this format has that the other three ReplayGain formats in this
 * directory don't:
 *
 * 1. `meta` is not a plain container: its payload carries a 4-byte version/flags
 *    field BEFORE its children, which `moov`, `udta` and `ilst` do not. Walking it
 *    like an ordinary container reads those 4 bytes as part of the first child's own
 *    header, misaligning everything after it. `META_VERSION_FLAGS_SIZE` below is
 *    skipped for exactly this one atom.
 * 2. A 32-bit size field of 1 means the real size is a 64-bit big-endian value in the
 *    8 bytes immediately following the type. `readAtomHeader` reads it as a `bigint`
 *    (so no shift ever loses precision) and only accepts it once it's small enough to
 *    equal a JS number exactly.
 * 3. A size field of 0 means "this atom runs to the end of the enclosing container."
 *    There is no separate "end of file" available once nesting is more than one atom
 *    deep, so this parser treats it as running to the end of whatever `end` boundary
 *    the caller already had; that is always a real, previously-validated boundary
 *    (the physical buffer length at the top level, an ancestor atom's own end once
 *    inside one), so it can never make an atom appear to run past bytes it hasn't
 *    already been allowed into.
 *
 * The fourth trap, an atom whose cursor doesn't strictly advance, is what would turn
 * any of the above into an infinite loop instead of a wrong answer. `readAtomHeader`
 * never returns an atom whose end is not strictly greater than its start: the size-0
 * case ends at `end`, which is always reachable only because the header itself (at
 * least 8 bytes) already fit before `end`; the size-1 case requires the 64-bit value
 * to be at least 16 (its own header's length); and the plain case requires the
 * declared size to be at least 8 (its own header's length). Every branch therefore
 * advances the cursor by at least 8 bytes, so the walk in `walkChildren` cannot hang.
 * `parseKeyNames` below walks `keys`' own entries independently of `walkChildren` (each
 * entry is a 4-byte size + 4-byte namespace + name, not a full nested atom), and is
 * built to the same rule: an entry is only accepted, and the cursor only advanced past
 * it, once its declared size is proven to be at least 8 (its own size+namespace
 * fields) and to not run past `keys`' own end. Whichever check fails first, the walk
 * stops and returns the names already read, exactly like `walkChildren` stopping at a
 * malformed child.
 *
 * Every read is bounds-checked against the buffer and against the enclosing atom's
 * own declared boundary. A malformed or truncated file must never throw: it returns
 * `{}`, or whatever tags were already read before truncation cut it off, because a
 * broken tag can never be allowed to take down playback.
 *
 * There is no encoder on this machine that writes the freeform scheme into an
 * MP4/M4A file: ffmpeg silently drops `-metadata REPLAYGAIN_*` for this container
 * unless told to write the OTHER (keys) scheme, and AtomicParsley, mp4tags and mid3v2
 * are all absent. So, like `apev2.ts`, `tests/fixtures/replaygain/build.ts`'s
 * `buildMp4` hand-builds freeform-scheme atom bytes from the same reading of the spec
 * this parser is written from, rather than from a captured real file; see that file's
 * module comment, and `tests/replaygain/mp4.test.ts`'s, for what that means for how
 * much of this parser's freeform path can be said to be verified. The keys scheme is
 * different: `tests/fixtures/replaygain/tone-keys.m4a` is genuine
 * `ffmpeg -movflags use_metadata_tags` output, so that half of this parser is checked
 * against real encoder bytes, independent of this file's own reading of the spec.
 */

const HEADER_SIZE = 8; // 4-byte size + 4-byte type
const EXTENDED_HEADER_SIZE = 16; // + 8-byte 64-bit size, when the 32-bit size field is 1
const META_VERSION_FLAGS_SIZE = 4;
const DATA_TYPE_LOCALE_SIZE = 8; // 4-byte type indicator + 4-byte locale, before a `data` atom's value
const FREEFORM_TYPE = "----";
const MEAN_APPLE_ITUNES = "com.apple.itunes"; // compared lowercased
const DATA_TYPE_UTF8_TEXT = 1;

const HDLR_TYPE = "hdlr";
const KEYS_TYPE = "keys";
// Within hdlr's payload: 4-byte version/flags, then 4-byte predefined (both ignored),
// then the 4-byte handler type this parser actually dispatches on.
const HDLR_HANDLER_TYPE_OFFSET = 8;
const HANDLER_MDTA = "mdta"; // the keys scheme
const HANDLER_MDIR = "mdir"; // the freeform scheme
const KEYS_VERSION_FLAGS_SIZE = 4;
const KEYS_ENTRY_COUNT_SIZE = 4;
// Within a `keys` entry: 4-byte entry size (itself + namespace + name) + 4-byte
// namespace, before the key name that fills out the rest of the entry.
const KEYS_ENTRY_HEADER_SIZE = 8;

function fourCC(bytes: Uint8Array, offset: number): string | undefined {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  return String.fromCharCode(b0, b1, b2, b3);
}

/** Big-endian uint32 read, bounds-checked against `end` (the enclosing atom's own
 * declared boundary, not just the physical buffer length, mirroring `apev2.ts` and
 * `id3v2.ts`'s `end`-bounded reads). */
function readUint32BE(bytes: Uint8Array, offset: number, end: number): number | undefined {
  if (offset < 0 || offset + 4 > end) return undefined;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** Big-endian uint64 read via `bigint` (a plain 32-bit shift-and-OR would silently
 * lose bits above 2^32), returned as a `number` only once it is small enough to
 * survive that conversion exactly. Real MP4 atoms are never anywhere near this size,
 * so refusing an oversized value is correct, not a limitation: it is one more shape a
 * malformed/hostile file can no longer turn into a wrong (or hanging) read. */
function readUint64BE(bytes: Uint8Array, offset: number, end: number): number | undefined {
  if (offset < 0 || offset + 8 > end) return undefined;
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const b = bytes[offset + i];
    if (b === undefined) return undefined;
    value = (value << 8n) | BigInt(b);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}

interface AtomHeader {
  type: string;
  /** Absolute offset of the first byte of this atom's payload (right after its
   * 8-byte header, or its 16-byte header when a 64-bit size extension is present). */
  payloadStart: number;
  /** Absolute offset one past this atom's last byte, i.e. where its next sibling (if
   * any) starts. Always strictly greater than the atom's own start offset: see the
   * module comment's note on why the walk in `walkChildren` cannot hang. */
  atomEnd: number;
}

/**
 * Reads one atom's header at `offset`, bounds-checked against `end` (the end of the
 * enclosing container: the physical buffer length at the top level, or an ancestor
 * atom's own `atomEnd` once inside one). Returns undefined, never a partially-read
 * header, for anything that doesn't fit: a declared size smaller than the header it
 * claims to be, a size that would run past `end`, or a 64-bit size too large to
 * represent exactly as a `number`.
 */
function readAtomHeader(bytes: Uint8Array, offset: number, end: number): AtomHeader | undefined {
  if (offset < 0 || offset + HEADER_SIZE > end) return undefined;
  const declaredSize = readUint32BE(bytes, offset, end);
  if (declaredSize === undefined) return undefined;
  const type = fourCC(bytes, offset + 4);
  if (type === undefined) return undefined;

  if (declaredSize === 0) {
    // Trap 3: this atom runs to the end of the enclosing container. `end` is always a
    // real, already-validated boundary (see the module comment), and the guard above
    // already proved `offset + HEADER_SIZE <= end`, so `end > offset`: the cursor
    // still strictly advances even for a zero-length payload.
    return { type, payloadStart: offset + HEADER_SIZE, atomEnd: end };
  }

  if (declaredSize === 1) {
    // Trap 2: the real size is the 64-bit value right after the type.
    const size64 = readUint64BE(bytes, offset + HEADER_SIZE, end);
    if (size64 === undefined) return undefined;
    if (size64 < EXTENDED_HEADER_SIZE) return undefined; // smaller than its own header
    const atomEnd = offset + size64;
    if (atomEnd > end) return undefined;
    return { type, payloadStart: offset + EXTENDED_HEADER_SIZE, atomEnd };
  }

  if (declaredSize < HEADER_SIZE) return undefined; // smaller than its own header
  const atomEnd = offset + declaredSize;
  if (atomEnd > end) return undefined;
  return { type, payloadStart: offset + HEADER_SIZE, atomEnd };
}

/**
 * Walks the direct children of a container atom whose payload spans `start` to `end`,
 * calling `visit` for each one in declaration order. Stops as soon as an atom's own
 * header doesn't fit (truncated or malformed) rather than throwing or looping:
 * whatever `visit` was already called with stays valid, per this subpath's truncation
 * convention.
 */
function walkChildren(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (header: AtomHeader) => void,
): void {
  let cursor = start;
  while (cursor + HEADER_SIZE <= end) {
    const header = readAtomHeader(bytes, cursor, end);
    if (!header) return;
    visit(header);
    cursor = header.atomEnd; // strictly > cursor: see readAtomHeader's guarantee
  }
}

/** Finds the first direct child of the given fourCC type within `start`..`end`, or
 * undefined if none is found before a malformed/truncated atom ends the walk. */
function findChild(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): AtomHeader | undefined {
  let found: AtomHeader | undefined;
  walkChildren(bytes, start, end, (header) => {
    if (!found && header.type === type) found = header;
  });
  return found;
}

/** Decodes an atom's payload as UTF-8 starting `skip` bytes in (past a 4-byte
 * version/flags field, for `mean`/`name`), running to the atom's own end. Returns
 * undefined rather than an empty string when `skip` alone already runs past the
 * atom's end, i.e. the atom is too short to even hold that field. */
function decodeAtomTail(bytes: Uint8Array, atom: AtomHeader, skip: number): string | undefined {
  const start = atom.payloadStart + skip;
  if (start > atom.atomEnd) return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, atom.atomEnd));
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

/**
 * Reads a `data` atom's own value (4-byte type indicator, 4-byte locale, then the
 * value bytes) and parses it as a ReplayGain number. Returns undefined for anything
 * that isn't a recognized-as-text value: too short to hold the type+locale fields, a
 * type indicator other than UTF-8 text, or text that doesn't parse to a finite number.
 * Shared by both schemes: a `data` atom has the identical shape whether it's reached
 * via a freeform `----` atom's own child or via a keys-scheme `ilst` entry's child.
 */
function readDataAtomValue(bytes: Uint8Array, data: AtomHeader): number | undefined {
  if (data.payloadStart + DATA_TYPE_LOCALE_SIZE > data.atomEnd) return undefined; // no room for type+locale
  const typeIndicator = readUint32BE(bytes, data.payloadStart, data.atomEnd);
  if (typeIndicator !== DATA_TYPE_UTF8_TEXT) return undefined;

  const valueBytes = bytes.subarray(data.payloadStart + DATA_TYPE_LOCALE_SIZE, data.atomEnd);
  const value = new TextDecoder("utf-8", { fatal: false }).decode(valueBytes);
  return parseGainValue(value);
}

/** Writes `parsed` into `tags` under whichever of the two recognized ReplayGain keys
 * `lowerKey` (already lower-cased) is. Callers only reach this after already
 * confirming `lowerKey` is one of the two, so the `else` is exhaustive, not a guess. */
function assignRecognizedKey(lowerKey: string, parsed: number, tags: ReplayGainTags): void {
  if (lowerKey === "replaygain_track_gain") tags.gainDb = parsed;
  else tags.peak = parsed;
}

/**
 * Reads one freeform `----` atom's `mean`/`name`/`data` children and, if it's a
 * recognized ReplayGain key scoped to the "com.apple.iTunes" freeform namespace,
 * writes the parsed value into `tags`. Silently does nothing for anything else found
 * under `ilst` (missing children, an unrecognized namespace, a non-text `data` type,
 * an unrecognized or unparseable key): this function is called once per freeform
 * atom, and one uninteresting/malformed atom must not stop the rest from being read.
 */
function readFreeformInto(bytes: Uint8Array, freeform: AtomHeader, tags: ReplayGainTags): void {
  let mean: AtomHeader | undefined;
  let name: AtomHeader | undefined;
  let data: AtomHeader | undefined;
  walkChildren(bytes, freeform.payloadStart, freeform.atomEnd, (child) => {
    if (child.type === "mean" && !mean) mean = child;
    else if (child.type === "name" && !name) name = child;
    else if (child.type === "data" && !data) data = child;
  });
  if (!mean || !name || !data) return;

  const meanValue = decodeAtomTail(bytes, mean, META_VERSION_FLAGS_SIZE);
  if (meanValue === undefined || meanValue.toLowerCase() !== MEAN_APPLE_ITUNES) return;

  const key = decodeAtomTail(bytes, name, META_VERSION_FLAGS_SIZE);
  if (key === undefined) return;
  const lowerKey = key.toLowerCase();
  if (lowerKey !== "replaygain_track_gain" && lowerKey !== "replaygain_track_peak") return;

  const parsed = readDataAtomValue(bytes, data);
  if (parsed === undefined) return;

  assignRecognizedKey(lowerKey, parsed, tags);
}

/** Reads `hdlr`'s handler type (the 4 bytes after its version/flags and predefined
 * fields), bounds-checked against `hdlr`'s own end. Returns undefined if `hdlr` is too
 * short to hold that field, which callers treat the same as "no hdlr at all": try
 * both schemes rather than guessing. */
function readHandlerType(bytes: Uint8Array, hdlr: AtomHeader): string | undefined {
  const offset = hdlr.payloadStart + HDLR_HANDLER_TYPE_OFFSET;
  if (offset + 4 > hdlr.atomEnd) return undefined;
  return fourCC(bytes, offset);
}

/**
 * Parses a `keys` atom's entries into an ordered list of key names (`names[0]` is key
 * index 1, `names[1]` is index 2, and so on: the keys scheme's indices are 1-based).
 *
 * Each entry is a 4-byte entry size (covering the size field itself, the 4-byte
 * namespace that follows it, and the name), then the namespace, then the name filling
 * out the rest of the declared size. This is walked by hand rather than through
 * `walkChildren`/`readAtomHeader` because an entry isn't a nested atom (it has no
 * separate type field to recurse through; its "type", such as it is, is the constant
 * `"mdta"` namespace baked into the format, not a distinguishing child type).
 *
 * Stops and returns whatever names were already read, per this parser's truncation
 * convention, as soon as an entry doesn't fit: `entrySize` unreadable, declared
 * smaller than its own 8-byte size+namespace header (which would either read the next
 * entry's bytes as this one's name, or, at `entrySize < 8`, fail to strictly advance
 * the cursor and hang), or its declared span running past `keys`' own end. Every
 * accepted entry advances the cursor by exactly its own `entrySize`, which is proven
 * `>= KEYS_ENTRY_HEADER_SIZE` (8) before it is used, so this loop cannot hang on a
 * malformed `keys` atom any more than `walkChildren` can on a malformed container.
 */
function parseKeyNames(bytes: Uint8Array, keys: AtomHeader): string[] {
  const names: string[] = [];
  let cursor = keys.payloadStart + KEYS_VERSION_FLAGS_SIZE + KEYS_ENTRY_COUNT_SIZE;
  while (cursor + KEYS_ENTRY_HEADER_SIZE <= keys.atomEnd) {
    const entrySize = readUint32BE(bytes, cursor, keys.atomEnd);
    if (entrySize === undefined || entrySize < KEYS_ENTRY_HEADER_SIZE) return names;
    const entryEnd = cursor + entrySize;
    if (entryEnd > keys.atomEnd) return names;

    const nameStart = cursor + KEYS_ENTRY_HEADER_SIZE;
    names.push(
      new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, entryEnd)),
    );
    cursor = entryEnd; // strictly > cursor: entrySize >= KEYS_ENTRY_HEADER_SIZE (8), checked above
  }
  return names;
}

/** Converts an `ilst` child's own 4-byte "type" field, as the keys scheme (ab)uses it,
 * back into the big-endian integer it actually is. `AtomHeader.type` is always exactly
 * 4 UTF-16 code units in the 0..255 range (produced by `fourCC`'s
 * `String.fromCharCode` from 4 real bytes), so this exactly reverses that encoding
 * rather than approximating it. */
function typeAsIndex(type: string): number {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    value = (value << 8) | (type.charCodeAt(i) & 0xff);
  }
  return value >>> 0;
}

/**
 * Reads one keys-scheme `ilst` child: resolves its numeric "type" to a key name via
 * `keyNames` (1-based), and if that name is a recognized ReplayGain key, reads its
 * `data` child's value and writes it into `tags`. Silently does nothing otherwise (an
 * out-of-range index, an unrecognized key name, a missing or unparseable `data`
 * value): mirrors `readFreeformInto`'s convention of never letting one uninteresting
 * or malformed `ilst` child stop the rest from being read.
 */
function readKeysEntryInto(
  bytes: Uint8Array,
  entry: AtomHeader,
  keyNames: string[],
  tags: ReplayGainTags,
): void {
  const index = typeAsIndex(entry.type);
  if (index < 1 || index > keyNames.length) return;
  const key = keyNames[index - 1];
  if (key === undefined) return;
  const lowerKey = key.toLowerCase();
  if (lowerKey !== "replaygain_track_gain" && lowerKey !== "replaygain_track_peak") return;

  const data = findChild(bytes, entry.payloadStart, entry.atomEnd, "data");
  if (!data) return;

  const parsed = readDataAtomValue(bytes, data);
  if (parsed === undefined) return;

  assignRecognizedKey(lowerKey, parsed, tags);
}

/**
 * Parses ReplayGain track gain/peak out of an MP4/M4A file's `moov.udta.meta.ilst`,
 * trying the iTunes freeform scheme, the QuickTime metadata-keys scheme, or both,
 * depending on `meta`'s `hdlr` atom: a handler type of `mdir` means freeform only,
 * `mdta` means keys only, and a missing `hdlr` (or one this parser doesn't recognize)
 * means both are tried, since a real but nonstandard file is more likely to actually
 * carry one of the two known shapes than a third, unknown one. Returns `{}` when any
 * atom in the shared `moov`/`udta`/`meta`/`ilst` chain is missing, malformed or
 * truncated, or when neither scheme finds a recognized ReplayGain tag: it never
 * throws.
 */
export function parseMp4(bytes: Uint8Array): ReplayGainTags {
  try {
    const moov = findChild(bytes, 0, bytes.length, "moov");
    if (!moov) return {};

    const udta = findChild(bytes, moov.payloadStart, moov.atomEnd, "udta");
    if (!udta) return {};

    const meta = findChild(bytes, udta.payloadStart, udta.atomEnd, "meta");
    if (!meta) return {};

    // Trap 1: `meta`'s payload carries a 4-byte version/flags field before its
    // children, unlike `moov`, `udta` and `ilst`. Skip it before walking further.
    const metaChildrenStart = meta.payloadStart + META_VERSION_FLAGS_SIZE;
    if (metaChildrenStart > meta.atomEnd) return {};

    const ilst = findChild(bytes, metaChildrenStart, meta.atomEnd, "ilst");
    if (!ilst) return {};

    const hdlr = findChild(bytes, metaChildrenStart, meta.atomEnd, HDLR_TYPE);
    const handlerType = hdlr ? readHandlerType(bytes, hdlr)?.toLowerCase() : undefined;

    const tags: ReplayGainTags = {};

    if (handlerType !== HANDLER_MDTA) {
      walkChildren(bytes, ilst.payloadStart, ilst.atomEnd, (child) => {
        if (child.type === FREEFORM_TYPE) readFreeformInto(bytes, child, tags);
      });
    }

    if (handlerType !== HANDLER_MDIR) {
      const keys = findChild(bytes, metaChildrenStart, meta.atomEnd, KEYS_TYPE);
      if (keys) {
        const keyNames = parseKeyNames(bytes, keys);
        walkChildren(bytes, ilst.payloadStart, ilst.atomEnd, (child) => {
          readKeysEntryInto(bytes, child, keyNames, tags);
        });
      }
    }

    return tags;
  } catch {
    return {};
  }
}
