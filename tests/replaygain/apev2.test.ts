import { describe, it, expect } from "vitest";
import { parseApev2 } from "../../src/replaygain/apev2";
import { buildApev2 } from "../fixtures/replaygain/build";

/**
 * There is no real-encoder-produced APEv2 fixture here (see build.ts's module comment
 * for why: nothing installed on this machine writes the format). Every tag byte tested
 * below is therefore hand-built from the same reading of the spec that `apev2.ts`
 * itself was written from, which is a genuine weakness: a misreading would make both
 * sides agree and every test here would still pass. `build.ts` is written so a
 * reviewer who knows the format can check the byte layout by eye, which is the
 * mitigation available in the absence of a second, independent source of truth.
 */

const GAIN_KEY = "REPLAYGAIN_TRACK_GAIN";
const PEAK_KEY = "REPLAYGAIN_TRACK_PEAK";
const GAIN_VALUE = "-6.50 dB";
const PEAK_VALUE = "0.988525";

const APE_MAGIC = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58]; // "APETAGEX"

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** Overwrites 4 bytes at `offset` with the little-endian encoding of `value`, in a
 * copy of `bytes`. Used to corrupt one specific field (e.g. the item count) while
 * leaving everything else, including the tag's own declared size, untouched. */
function patchU32LE(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const mutated = bytes.slice();
  const patched = u32le(value);
  for (let i = 0; i < 4; i++) mutated[offset + i] = patched[i] as number;
  return mutated;
}

describe("APEv2", () => {
  /**
   * The flag bits, written as literals rather than through build.ts's named constants.
   *
   * Every other test here builds its fixture with the same constants the parser reads,
   * so if a constant is wrong the fixture and the parser agree and the test still passes
   * while real files fail. That is not hypothetical: these two bits WERE swapped in both
   * places, and the "header present" test below passed throughout.
   *
   * Per the APEv2 spec, bit 31 says the tag has a header somewhere (set identically on
   * both copies) and bit 29 says this block is the header rather than the footer. A real
   * tagger writing a header plus a footer therefore gives the FOOTER flags 0x80000000:
   * bit 31 set, bit 29 clear.
   */
  it("reads a header-plus-footer tag whose flag bits are what the spec actually says", () => {
    const items = { REPLAYGAIN_TRACK_GAIN: "-6.50 dB", REPLAYGAIN_TRACK_PEAK: "0.988525" };
    const raw = buildApev2(items);

    // Rewrite both blocks' flags fields with spec literals, independent of any constant.
    const bytes = new Uint8Array(raw);
    const view = new DataView(bytes.buffer);
    const HAS_HEADER = 0x80000000; // bit 31
    const IS_HEADER = 0x20000000; // bit 29
    view.setUint32(20, HAS_HEADER | IS_HEADER, true); // header block, at offset 0
    view.setUint32(bytes.length - 32 + 20, HAS_HEADER, true); // footer block, at the end

    expect(parseApev2(bytes)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });
  it("reads gain and peak from a footer-only tag", () => {
    const tag = buildApev2(
      { [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE },
      { footerOnly: true },
    );
    expect(parseApev2(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("reads gain and peak from a footer-only tag preceded by unrelated bytes, as a tail Range fragment would be", () => {
    // fetch-range.ts's tail request returns the LAST N bytes of a file, not the tag on
    // its own: the tag is preceded by whatever audio data happened to fall inside that
    // range. `parseApev2` only ever looks at `bytes.length - 32` for the footer, so
    // prepending unrelated bytes before a real tag must not change the result.
    const tag = buildApev2(
      { [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE },
      { footerOnly: true },
    );
    const precedingAudioBytes = new Uint8Array(500).fill(0xaa);
    const fragment = new Uint8Array(precedingAudioBytes.length + tag.length);
    fragment.set(precedingAudioBytes, 0);
    fragment.set(tag, precedingAudioBytes.length);
    expect(parseApev2(fragment)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("reads gain and peak from a tag with a header present", () => {
    const tag = buildApev2(
      { [GAIN_KEY]: GAIN_VALUE, [PEAK_KEY]: PEAK_VALUE },
      { footerOnly: false },
    );
    expect(parseApev2(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("matches keys case-insensitively", () => {
    const tag = buildApev2(
      { replaygain_track_gain: GAIN_VALUE, replaygain_track_peak: PEAK_VALUE },
      { footerOnly: true },
    );
    expect(parseApev2(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("returns {} for bytes with no APETAGEX anywhere", () => {
    expect(parseApev2(new Uint8Array([1, 2, 3, 4]))).toEqual({});
    expect(parseApev2(new Uint8Array(0))).toEqual({});
  });

  it("returns {} when the item count overruns the buffer", () => {
    // Zero real items (itemsSize is 0, so itemsStart === itemsEnd, i.e. there is
    // physically no room for even one item), then the footer's item-count field alone
    // is patched to claim 5 items exist. The tag's declared SIZE is left untouched, so
    // this exercises the per-item bounds check inside the item-reading loop, not the
    // top-level "does the tag fit in the buffer" check: if that outer check were the
    // one catching this, cutting itemsSize instead of patching itemCount would also
    // have produced {}, and this test would prove nothing about the loop's own bound.
    const tag = buildApev2({}, { footerOnly: true });
    // Footer is the last 32 bytes; item count is the 4 LE bytes at footer offset +16.
    const itemCountOffset = tag.length - 32 + 16;
    const inflated = patchU32LE(tag, itemCountOffset, 5);
    expect(parseApev2(inflated)).toEqual({});
  });

  it("treats a gain value that does not parse as a number as absent, not zero", () => {
    const tag = buildApev2(
      { [GAIN_KEY]: "xx.xx dB", [PEAK_KEY]: PEAK_VALUE },
      { footerOnly: true },
    );
    expect(parseApev2(tag)).toEqual({ peak: 0.988525 });
  });

  it("treats a gain value that overflows to a non-finite number as absent, not the overflowed value", () => {
    // Distinct from the "xx.xx dB" test above: that one never matches the leading
    // numeric regex at all. This one DOES match (400 digits is a syntactically valid
    // number), but parseFloat of it overflows past Number.MAX_VALUE to Infinity,
    // which is what specifically exercises the Number.isFinite guard rather than the
    // regex-match check.
    const hugeDigits = "9".repeat(400);
    const tag = buildApev2(
      { [GAIN_KEY]: hugeDigits, [PEAK_KEY]: PEAK_VALUE },
      { footerOnly: true },
    );
    expect(parseApev2(tag)).toEqual({ peak: 0.988525 });
  });

  it("returns {} rather than accepting a value truncated by its own inflated declared size", () => {
    // The item's own value-size field is the first 4 bytes of a footer-only tag
    // (items start immediately at offset 0 when there's no header). Inflating just
    // that one field, while leaving the tag's own overall size/item-count fields
    // (and so the outer "does the tag fit in the buffer" check) untouched, isolates
    // the per-item bounds check inside the read loop: without it, the value would be
    // silently clamped to whatever bytes happen to follow (here, the footer's own
    // magic/version/size bytes) instead of the read being rejected outright.
    const tag = buildApev2({ [GAIN_KEY]: GAIN_VALUE }, { footerOnly: true });
    const inflatedValueSize = GAIN_VALUE.length + 1000;
    const inflated = patchU32LE(tag, 0, inflatedValueSize);
    expect(parseApev2(inflated)).toEqual({});
  });

  it("returns {} when an item's key has no null terminator before the tag's own end", () => {
    // Hand-built rather than via buildApev2 (whose items always terminate the key
    // properly): this item's "key" bytes run all the way to the tag's own end with no
    // 0x00 anywhere in them, standing in for a corrupted item whose terminator was
    // never written. Neither the key ("BADKEY") nor the value ("data") bytes contain
    // a zero byte, so there is genuinely nothing for the terminator scan to find.
    const key = asciiBytes("BADKEY");
    const value = asciiBytes("data");
    const item = [...u32le(value.length), ...u32le(0), ...key, ...value]; // no terminator byte
    const tagSize = item.length + 32;
    const footer = [
      ...APE_MAGIC,
      ...u32le(2000),
      ...u32le(tagSize),
      ...u32le(1), // one item claimed
      ...u32le(0), // flags: not a header, no header present
      ...new Array(8).fill(0x00),
    ];
    const tag = new Uint8Array([...item, ...footer]);
    expect(parseApev2(tag)).toEqual({});
  });

  it("reads a header-only tag with no footer at all, falling back to the start-of-buffer search", () => {
    // build.ts has no "header, no footer" option (that shape isn't part of its
    // documented interface), so this one hand-builds the bytes directly: a single
    // 32-byte header block (flags = HEADER_FLAG | HAS_HEADER_FLAG) followed immediately
    // by one item, with nothing after it. The end-of-buffer search must fail to find
    // "APETAGEX" there (the last 32 bytes are item bytes, not a footer), which is what
    // forces the fallback to the start-of-buffer check that finds the header instead.
    const HEADER_FLAG = 0x80000000;
    const HAS_HEADER_FLAG = 0x20000000;
    const valueBytes = asciiBytes(GAIN_VALUE);
    const item = [
      ...u32le(valueBytes.length),
      ...u32le(0),
      ...asciiBytes(GAIN_KEY),
      0x00,
      ...valueBytes,
    ];
    const tagSize = item.length + 32; // items + footer size, even though no footer is written
    const header = [
      ...APE_MAGIC,
      ...u32le(2000),
      ...u32le(tagSize),
      ...u32le(1),
      ...u32le(HEADER_FLAG | HAS_HEADER_FLAG),
      ...new Array(8).fill(0x00),
    ];
    const tag = new Uint8Array([...header, ...item]);

    // Confirms the premise: the last 8 bytes of this fixture are NOT "APETAGEX", so a
    // parser that only checked the end of the buffer would find nothing here.
    const tail = tag.slice(tag.length - 8);
    expect(Array.from(tail)).not.toEqual(APE_MAGIC);

    expect(parseApev2(tag)).toEqual({ gainDb: -6.5 });
  });
});
