import { describe, it, expect } from "vitest";
import { parseMp4 } from "../../src/replaygain/mp4";
import { buildMp4 } from "../fixtures/replaygain/build";

/**
 * There is no real-encoder-produced MP4/M4A fixture here (see build.ts's module
 * comment for why: ffmpeg silently drops `-metadata REPLAYGAIN_*` for this container,
 * and AtomicParsley/mp4tags/mid3v2 are all absent on this machine). Every atom byte
 * tested below is therefore hand-built from the same reading of the spec that
 * `mp4.ts` itself was written from, which is a genuine weakness: a misreading would
 * make both sides agree and every test here would still pass. `build.ts` is written
 * so a reviewer who knows the format can check the byte layout by eye, which is the
 * mitigation available in the absence of a second, independent source of truth.
 */

const GAIN_KEY = "replaygain_track_gain";
const PEAK_KEY = "replaygain_track_peak";
const GAIN_VALUE = "-6.50 dB";
const PEAK_VALUE = "0.988525";

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** Plain 32-bit big-endian encoding: every MP4 atom size/type-indicator/locale field
 * uses this, unlike APEv2/ID3v2's little-endian and syncsafe fields respectively. */
function u32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] as number;
  const b1 = bytes[offset + 1] as number;
  const b2 = bytes[offset + 2] as number;
  const b3 = bytes[offset + 3] as number;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** Overwrites 4 bytes at `offset` with the big-endian encoding of `value`, in a copy
 * of `bytes`. Used to corrupt one specific field (an atom's own declared size) while
 * leaving everything else untouched, mirroring apev2.test.ts's `patchU32LE`. */
function patchU32BE(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const mutated = bytes.slice();
  const patched = u32BE(value);
  for (let i = 0; i < 4; i++) mutated[offset + i] = patched[i] as number;
  return mutated;
}

/**
 * `buildMp4`'s output is always exactly this chain, each link starting right after
 * its parent's own header (`meta` additionally has a 4-byte version/flags field
 * before its own children, which none of its ancestors or `ilst` have): a single
 * `moov` atom, containing a single `udta` atom, containing a single `meta` atom,
 * containing (after that version/flags field) a single `ilst` atom, whose children
 * are one freeform `----` atom per item passed to `buildMp4`. These offsets let a
 * test reach into that fixture and corrupt one exact field without depending on
 * `mp4.ts`'s own atom-walking code to find it (which would let a broken walker hide
 * the very corruption a test is trying to introduce).
 */
const MOOV_HEADER = 8;
const UDTA_HEADER = 8;
const META_HEADER = 8;
const META_VERSION_FLAGS = 4;
const ILST_HEADER = 8;

const UDTA_OFFSET = MOOV_HEADER;
const META_OFFSET = UDTA_OFFSET + UDTA_HEADER;
const ILST_OFFSET = META_OFFSET + META_HEADER + META_VERSION_FLAGS;
const FIRST_FREEFORM_OFFSET = ILST_OFFSET + ILST_HEADER;

describe("MP4/M4A freeform atoms", () => {
  it("reads gain and peak from a built fixture", () => {
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE });
    expect(parseMp4(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("matches keys case-insensitively", () => {
    const tag = buildMp4({
      REPLAYGAIN_TRACK_GAIN: GAIN_VALUE,
      REPLAYGAIN_TRACK_PEAK: PEAK_VALUE,
    });
    expect(parseMp4(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("finds the tag despite meta's version/flags field before its children", () => {
    // buildMp4 always writes meta's real 4-byte version/flags field before ilst (see
    // build.ts's module comment). If a parser walked meta as an ordinary container
    // (moov/udta/ilst all are; meta alone is not) it would read those 4 bytes as the
    // leading 4 bytes of what should be ilst's own 4-byte size field instead. Those
    // bytes are zero here (a real encoder's meta version/flags is 0), so the
    // resulting misread declared size is 0, which this parser's OWN size-0 rule reads
    // as "runs to the end of the enclosing container" -- consuming the rest of meta's
    // payload as this single, wrongly-typed pseudo-atom (its fourCC would be read from
    // ilst's real size bytes, not "ilst") and never reaching a real ilst atom at all.
    // So a parser that fails to skip those 4 bytes finds no ilst, and so no tag, here.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });

    // Confirms the premise: meta's version/flags field really is 4 zero bytes,
    // sitting right where this test's reasoning says it does.
    const metaVersionFlagsOffset = META_OFFSET + META_HEADER;
    expect(Array.from(tag.subarray(metaVersionFlagsOffset, metaVersionFlagsOffset + 4))).toEqual([
      0, 0, 0, 0,
    ]);

    expect(parseMp4(tag)).toEqual({ gainDb: -6.5 });
  });

  it("handles a 64-bit atom size (size field 1) rather than misreading it as a tiny atom", () => {
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });

    // Rewrite udta's header from the plain 8-byte form (4-byte size + 4-byte type) to
    // the 64-bit-extended form: a 4-byte size field of 1, the same 4-byte type, then
    // the real size as an 8-byte big-endian value. udta's payload (everything from
    // meta onward) is copied through unchanged; only its header grows by 8 bytes, so
    // moov's own declared size (the only thing that references udta's length) grows
    // by the same 8 bytes to stay consistent.
    const udtaDeclaredSize = readU32BE(tag, UDTA_OFFSET);
    const udtaType = tag.subarray(UDTA_OFFSET + 4, UDTA_OFFSET + 8);
    const udtaPayload = tag.subarray(UDTA_OFFSET + UDTA_HEADER, UDTA_OFFSET + udtaDeclaredSize);
    const extendedUdtaSize = udtaDeclaredSize + 8; // +8 for the larger header alone

    const moovDeclaredSize = readU32BE(tag, 0);
    const moovType = tag.subarray(4, 8);

    const rebuilt = new Uint8Array([
      ...u32BE(moovDeclaredSize + 8), // moov grew by udta's extra 8 header bytes
      ...moovType,
      ...u32BE(1), // udta's new declared size: 1, meaning "read the real size below"
      ...udtaType,
      ...u32BE(0), // high 32 bits of the 64-bit size: always 0 for a tag this small
      ...u32BE(extendedUdtaSize), // low 32 bits: the real size
      ...udtaPayload,
    ]);

    // Confirms the premise: the rebuilt tag really is 8 bytes longer, and udta's
    // declared size really is the literal value 1, not some other small number.
    expect(rebuilt.length).toBe(tag.length + 8);
    expect(readU32BE(rebuilt, UDTA_OFFSET)).toBe(1);

    expect(parseMp4(rebuilt)).toEqual({ gainDb: -6.5 });
  });

  it("returns {} when a 64-bit size field is itself truncated", () => {
    // Same header rewrite as the test above (udta's plain 8-byte header replaced by
    // the 16-byte extended form), but the buffer is then cut off 4 bytes into the
    // 8-byte size64 field instead of after it. This isolates readUint64BE's own
    // bounds check: declaredSize === 1 is read fine (it's before the cut), but the
    // real size that's supposed to follow it is only half there.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });

    const udtaType = tag.subarray(UDTA_OFFSET + 4, UDTA_OFFSET + 8);

    const truncated = new Uint8Array([
      ...tag.subarray(0, UDTA_OFFSET),
      ...u32BE(1), // udta's declared size: 1, meaning "read the real size below"
      ...udtaType,
      ...u32BE(0), // only the high 4 bytes of the 64-bit size are present...
      // ...and then nothing: the buffer ends before the low 4 bytes, and before any
      // of udta's real payload (meta/ilst/the freeform tag) too.
    ]);

    expect(parseMp4(truncated)).toEqual({});
  });

  it("returns {} when an inflated 64-bit size runs past its enclosing container", () => {
    // A second, independent 64-bit-size test from the two above: this one targets
    // the size-1 branch's own `atomEnd > end` bounds check, using a fixture with TWO
    // freeform items (gain, peak) so there's a real sibling atom to leak into.
    //
    // The first freeform atom's plain 8-byte header is rewritten to the 16-byte
    // extended form, with its declared 64-bit size covering its own real payload
    // PLUS the entire second freeform atom's real bytes -- i.e. exactly 8 bytes more
    // than ilst's own (deliberately left unchanged) declared size accounts for,
    // since growing a header by 8 bytes without removing anything grows the atom's
    // true footprint by that same 8 bytes. `ilst`'s, `meta`'s, `udta`'s and `moov`'s
    // own declared sizes are all left exactly as `buildMp4` wrote them: none of them
    // are told about those extra 8 bytes.
    //
    // A parser that enforces the size-1 branch's own container bound rejects the
    // first freeform atom outright (its declared end doesn't fit within ilst's own,
    // unchanged, end) and finds neither tag: {}. A parser that skips that bound
    // accepts it, reads gain correctly from the first freeform atom's own (genuine,
    // untouched) mean/name/data children, and then -- because the ilst-level walk's
    // cursor jumps to this atom's inflated end, past where the real second freeform
    // atom starts -- never visits that second atom as ilst's own child at all. Peak
    // is silently dropped rather than the whole tag being rejected: { gainDb: -6.5 }
    // instead of {}, which is the wrong-answer failure mode this bound prevents.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE });

    const freeform1Offset = FIRST_FREEFORM_OFFSET;
    const freeform1Size = readU32BE(tag, freeform1Offset);
    const freeform2Offset = freeform1Offset + freeform1Size;
    const freeform2Size = readU32BE(tag, freeform2Offset);

    const freeform1Type = tag.subarray(freeform1Offset + 4, freeform1Offset + 8);
    const freeform1Payload = tag.subarray(freeform1Offset + 8, freeform1Offset + freeform1Size);
    const freeform2FullBytes = tag.subarray(freeform2Offset, freeform2Offset + freeform2Size);

    // The atom's own true size, given its bigger 16-byte header and its swallowed
    // sibling: 16 (new header) + its own original payload + all of freeform2's bytes.
    const inflatedSize64 = 16 + freeform1Payload.length + freeform2FullBytes.length;

    const mutated = new Uint8Array([
      ...tag.subarray(0, freeform1Offset), // moov/udta/meta/ilst headers, unchanged
      ...u32BE(1), // freeform1's declared size: 1, meaning "read the real size below"
      ...freeform1Type,
      ...u32BE(0), // high 32 bits of the 64-bit size
      ...u32BE(inflatedSize64), // low 32 bits: swallows freeform2 whole
      ...freeform1Payload, // freeform1's own real mean/name/data, untouched
      ...freeform2FullBytes, // freeform2's real bytes, now "inside" freeform1's span
    ]);

    // Confirms the premise: the buffer really did grow by exactly 8 bytes (the extra
    // header size), and freeform1's declared size really is the literal value 1.
    expect(mutated.length).toBe(tag.length + 8);
    expect(readU32BE(mutated, freeform1Offset)).toBe(1);

    expect(parseMp4(mutated)).toEqual({});
  });

  it("treats a size-0 atom as running to the end of its enclosing container", () => {
    // The sole freeform "----" atom built here is also the last (and only) child of
    // ilst, so its true end already coincides with ilst's own end. Patching its
    // declared size field to 0 therefore changes nothing about where it actually
    // ends, but does isolate the size-0 rule: a parser that instead treated a
    // declared size of 0 as a literal zero-length atom would compute an end equal to
    // its own start (no strict advance), fail this atom's own `< HEADER_SIZE` guard,
    // and so never find a "----" child under ilst at all.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });

    expect(readU32BE(tag, FIRST_FREEFORM_OFFSET)).not.toBe(0); // premise: real size, not already 0
    const patched = patchU32BE(tag, FIRST_FREEFORM_OFFSET, 0);

    expect(parseMp4(patched)).toEqual({ gainDb: -6.5 });
  });

  it("returns {} for a truncated file", () => {
    // Cutting bytes off the tail leaves every enclosing atom's own declared size
    // (moov's included) claiming more bytes than the buffer now has. The outermost
    // check, moov's own header read at the very top of parseMp4, is what actually
    // rejects this: moov's declared size runs past the truncated buffer's length
    // before any inner atom is ever looked at. That is inherent to truncating from
    // the tail (every ancestor atom's declared size necessarily spans the missing
    // bytes too), not a gap in coverage of the inner walking logic, which the
    // size-0/size-1/meta-skip tests above already exercise directly.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE });
    const truncated = tag.subarray(0, tag.length - 5);
    expect(parseMp4(truncated)).toEqual({});
  });

  it("returns {} for bytes with no moov atom at all", () => {
    expect(parseMp4(new Uint8Array([1, 2, 3, 4]))).toEqual({});
    expect(parseMp4(new Uint8Array(0))).toEqual({});
  });

  it("ignores a freeform atom outside the com.apple.iTunes namespace", () => {
    // A "----" atom whose `mean` value isn't "com.apple.iTunes" is a freeform tag
    // some other application owns; this parser must not treat its `name` as a
    // ReplayGain key just because the atom shape happens to match.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });

    const meanValueOffset =
      FIRST_FREEFORM_OFFSET +
      8 /* freeform's own header */ +
      8 /* mean atom's header */ +
      4; /* mean atom's version/flags */
    const original = "com.apple.iTunes";
    const replacement = "org.example.priv"; // same length, so no size fields need updating
    expect(replacement.length).toBe(original.length);
    const mutated = tag.slice();
    const replacementBytes = asciiBytes(replacement);
    for (let i = 0; i < replacementBytes.length; i++) {
      mutated[meanValueOffset + i] = replacementBytes[i] as number;
    }

    expect(parseMp4(mutated)).toEqual({});
  });

  it("treats a gain value that does not parse as a number as absent, not zero", () => {
    const tag = buildMp4({ [GAIN_KEY]: "xx.xx dB", [PEAK_KEY]: PEAK_VALUE });
    expect(parseMp4(tag)).toEqual({ peak: 0.988525 });
  });

  it("treats a gain value that overflows to a non-finite number as absent, not the overflowed value", () => {
    // Distinct from the "xx.xx dB" test above: that one never matches the leading
    // numeric regex at all. This one DOES match (400 digits is syntactically a valid
    // number), but parseFloat of it overflows past Number.MAX_VALUE to Infinity,
    // which is what specifically exercises the Number.isFinite guard rather than the
    // regex-match check.
    const hugeDigits = "9".repeat(400);
    const tag = buildMp4({ [GAIN_KEY]: hugeDigits, [PEAK_KEY]: PEAK_VALUE });
    expect(parseMp4(tag)).toEqual({ peak: 0.988525 });
  });

  it("ignores a data atom whose type indicator is not UTF-8 text", () => {
    // Type indicator 1 means UTF-8 text; anything else (e.g. binary data) has no
    // meaningful string value to parse a number out of, so it must be skipped rather
    // than decoded as if it were text.
    const tag = buildMp4({ [GAIN_KEY]: GAIN_VALUE });
    const dataTypeIndicatorOffset =
      FIRST_FREEFORM_OFFSET +
      8 /* freeform's own header */ +
      (8 + 4 + "com.apple.iTunes".length) /* full mean atom */ +
      (8 + 4 + GAIN_KEY.length) /* full name atom */ +
      8; /* data atom's own header, landing on its type-indicator field */
    expect(readU32BE(tag, dataTypeIndicatorOffset)).toBe(1); // premise: UTF-8 text, as built
    const patched = patchU32BE(tag, dataTypeIndicatorOffset, 0); // 0: reserved/binary, not text
    expect(parseMp4(patched)).toEqual({});
  });

  it("ignores a freeform atom whose name is not a recognized ReplayGain key", () => {
    // mean is still "com.apple.iTunes" (buildMp4 always writes that), only the name
    // differs. A key this parser doesn't recognize must be dropped, not folded into
    // "peak" by an overly permissive else-branch.
    const tag = buildMp4({ some_other_itunes_tag: "1.23" });
    expect(parseMp4(tag)).toEqual({});
  });

  it("ignores a non-freeform atom under ilst even if it has mean/name/data children", () => {
    // buildMp4 only ever writes "----"-typed children under ilst, so this fixture is
    // hand-built directly: one child of ilst typed "xxxx" instead of "----", whose
    // payload happens to contain the exact same mean("com.apple.iTunes")/
    // name("replaygain_track_gain")/data(1, 0, "-6.50 dB") shape a real freeform atom
    // would. Only the "----" type identifies a freeform atom; matching internal
    // shape alone must not be enough to be read as one.
    function rawAtom(type: string, payload: number[]): number[] {
      return [...u32BE(8 + payload.length), ...asciiBytes(type), ...payload];
    }

    const mean = rawAtom("mean", [...u32BE(0), ...asciiBytes("com.apple.iTunes")]);
    const name = rawAtom("name", [...u32BE(0), ...asciiBytes(GAIN_KEY)]);
    const data = rawAtom("data", [...u32BE(1), ...u32BE(0), ...asciiBytes(GAIN_VALUE)]);
    const notAFreeformAtom = rawAtom("xxxx", [...mean, ...name, ...data]);

    const ilst = rawAtom("ilst", notAFreeformAtom);
    const meta = rawAtom("meta", [...u32BE(0), ...ilst]);
    const udta = rawAtom("udta", meta);
    const moov = rawAtom("moov", udta);
    const tag = new Uint8Array(moov);

    expect(parseMp4(tag)).toEqual({});
  });
});
