import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseId3v2 } from "../../src/replaygain/id3v2";

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/replaygain/${name}`, import.meta.url)));

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** Plain 32-bit big-endian encoding, used for ID3v2.3 frame sizes. */
function u32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Syncsafe 28-bit encoding (7 bits per byte): the header's own size field in both
 * v2.3 and v2.4, and the frame size field in v2.4 only. */
function syncsafe32(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

/** UTF-16LE encoding of a string, with no BOM and no terminator: for building UTF-16
 * TXXX bodies byte-by-byte so the test controls the terminator explicitly. */
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return out;
}

/** UTF-16BE encoding, same shape as `utf16le` but byte-swapped. */
function utf16be(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push((code >> 8) & 0xff, code & 0xff);
  }
  return out;
}

/**
 * Builds a minimal ID3v2 tag containing exactly one frame, so the parser's handling
 * of a specific version/encoding combination can be tested in isolation from a real
 * encoder's output. `major` (3 or 4) controls only how the FRAME size is encoded
 * (plain big-endian for 2.3, syncsafe for 2.4): the header's own size field is
 * syncsafe in both versions, so it is always built that way here.
 */
function buildId3v2Tag(options: {
  major: number;
  frameId?: string;
  frameBody: number[];
  extendedHeaderFlag?: boolean;
  extendedHeaderBytes?: number[];
}): Uint8Array {
  const {
    major,
    frameId = "TXXX",
    frameBody,
    extendedHeaderFlag = false,
    extendedHeaderBytes = [],
  } = options;

  const frameSizeBytes = major >= 4 ? syncsafe32(frameBody.length) : u32BE(frameBody.length);
  const frame = [...asciiBytes(frameId), ...frameSizeBytes, 0x00, 0x00, ...frameBody];

  const bodyAfterHeader = extendedHeaderFlag ? [...extendedHeaderBytes, ...frame] : frame;

  const header = [
    ...asciiBytes("ID3"),
    major,
    0x00, // revision
    extendedHeaderFlag ? 0x40 : 0x00, // flags: bit 6 = extended header present
    ...syncsafe32(bodyAfterHeader.length),
  ];

  return new Uint8Array([...header, ...bodyAfterHeader]);
}

/** A TXXX frame body: 1 encoding byte, null-terminated description, then the value,
 * with the terminator width (1 byte or 2) matching the encoding. */
function txxxBody(
  encodingByte: number,
  description: string,
  value: string,
  trailingPadding = 0,
): number[] {
  switch (encodingByte) {
    case 0x00: // ISO-8859-1
    case 0x03: // UTF-8
      return [
        encodingByte,
        ...asciiBytes(description),
        0x00,
        ...asciiBytes(value),
        ...new Array(trailingPadding).fill(0x00),
      ];
    case 0x01: // UTF-16 with a leading BOM (little-endian here)
      return [
        encodingByte,
        0xff,
        0xfe, // BOM: little-endian
        ...utf16le(description),
        0x00,
        0x00,
        0xff,
        0xfe,
        ...utf16le(value),
      ];
    case 0x02: // UTF-16BE, no BOM
      return [encodingByte, ...utf16be(description), 0x00, 0x00, ...utf16be(value)];
    default:
      throw new Error(`unsupported encoding byte in test helper: ${encodingByte}`);
  }
}

describe("ID3v2", () => {
  it("reads gain from a real MP3 fixture (ID3v2.4 TXXX)", () => {
    expect(parseId3v2(load("tone.mp3"))).toEqual({ gainDb: -6.5 });
  });

  /**
   * The classic bug this parser must not have: ID3v2.3 frame sizes are a plain 32-bit
   * big-endian integer, NOT syncsafe. For a small frame the two readings often agree
   * (only the size field's last byte is nonzero, and both formulas treat that byte
   * identically), so a parser with the branches swapped can still pass a naive test.
   * This frame is padded past 128 bytes so its size's last byte has bit 7 set: a
   * syncsafe (mis)read masks that bit away and gets a completely different, smaller
   * number, truncating the frame before its description/value and losing the tag.
   */
  it("reads a hand-built ID3v2.3 tag whose frame size needs the big-endian (non-syncsafe) reading", () => {
    const body = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB", 100);
    expect(body.length).toBeGreaterThan(128);
    expect(body.length & 0xff).toBeGreaterThan(0x7f);
    const tag = buildId3v2Tag({ major: 3, frameBody: body });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("matches a lower-case TXXX description the same as upper case", () => {
    const body = txxxBody(0x03, "replaygain_track_gain", "-6.50 dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("returns {} for bytes with no ID3 magic", () => {
    expect(parseId3v2(new Uint8Array([1, 2, 3, 4]))).toEqual({});
    expect(parseId3v2(new Uint8Array(0))).toEqual({});
  });

  it("returns {} rather than throwing when the tag's declared size runs past the buffer", () => {
    // The frame itself is complete and would parse fine on its own: the ONLY problem
    // is the header's own size field claiming the tag is far bigger than the buffer
    // actually is (as a truncated file would look). Overwriting just the header's size
    // field, rather than cutting frame bytes off the end, is deliberate: an earlier
    // version of this test truncated frame bytes instead, which happened to also get
    // caught by the TXXX body reader failing to find its terminator in the clamped
    // (shortened) subarray it was handed. That coincidence meant the test passed
    // whether or not the top-level size check existed, proving nothing about it. This
    // version leaves the frame bytes untouched so the size check is the only thing
    // that can make the test pass.
    const body = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    const inflated = tag.slice();
    const bloatedSize = syncsafe32(tag.length - 10 + 1000); // claim 1000 bytes more than exist
    inflated.set(bloatedSize, 6);
    expect(parseId3v2(inflated)).toEqual({});
  });

  it("reads both gain and peak from separate TXXX frames", () => {
    const gainBody = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const peakBody = txxxBody(0x03, "REPLAYGAIN_TRACK_PEAK", "0.988525");
    const gainFrame = [
      ...asciiBytes("TXXX"),
      ...syncsafe32(gainBody.length),
      0x00,
      0x00,
      ...gainBody,
    ];
    const peakFrame = [
      ...asciiBytes("TXXX"),
      ...syncsafe32(peakBody.length),
      0x00,
      0x00,
      ...peakBody,
    ];
    const header = [
      ...asciiBytes("ID3"),
      4,
      0x00,
      0x00,
      ...syncsafe32(gainFrame.length + peakFrame.length),
    ];
    const tag = new Uint8Array([...header, ...gainFrame, ...peakFrame]);
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("ignores a non-TXXX frame that precedes the TXXX frame", () => {
    const titleBody = [0x00, ...asciiBytes("Some Title"), 0x00];
    const gainBody = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const titleFrame = [
      ...asciiBytes("TIT2"),
      ...syncsafe32(titleBody.length),
      0x00,
      0x00,
      ...titleBody,
    ];
    const gainFrame = [
      ...asciiBytes("TXXX"),
      ...syncsafe32(gainBody.length),
      0x00,
      0x00,
      ...gainBody,
    ];
    const header = [
      ...asciiBytes("ID3"),
      4,
      0x00,
      0x00,
      ...syncsafe32(titleFrame.length + gainFrame.length),
    ];
    const tag = new Uint8Array([...header, ...titleFrame, ...gainFrame]);
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("skips a v2.4 extended header instead of misreading it as a frame", () => {
    // v2.4 extended header: a 4-byte syncsafe size (INCLUDING these 4 bytes), then a
    // 1-byte "number of flag bytes" (1) and 1 flags byte, for a minimal 6-byte header.
    const extendedHeaderBytes = [...syncsafe32(6), 0x01, 0x00];
    const body = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const tag = buildId3v2Tag({
      major: 4,
      frameBody: body,
      extendedHeaderFlag: true,
      extendedHeaderBytes,
    });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("decodes an ISO-8859-1 (encoding 0x00) TXXX frame", () => {
    const body = txxxBody(0x00, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("decodes a UTF-16 with BOM (encoding 0x01) TXXX frame, whose terminator is two bytes", () => {
    const body = txxxBody(0x01, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("decodes a UTF-16BE without BOM (encoding 0x02) TXXX frame", () => {
    const body = txxxBody(0x02, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("treats a gain value that does not parse as a number as absent, not zero", () => {
    const body = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "xx.xx dB");
    const tag = buildId3v2Tag({ major: 4, frameBody: body });
    expect(parseId3v2(tag)).toEqual({});
  });

  it("returns whatever was already found rather than throwing when a frame's declared size runs past the physical buffer", () => {
    const gainBody = txxxBody(0x03, "REPLAYGAIN_TRACK_GAIN", "-6.50 dB");
    const gainFrame = [
      ...asciiBytes("TXXX"),
      ...syncsafe32(gainBody.length),
      0x00,
      0x00,
      ...gainBody,
    ];
    // A second frame whose header claims a body far larger than actually follows.
    const brokenFrameHeader = [...asciiBytes("TXXX"), ...syncsafe32(9000), 0x00, 0x00];
    const header = [
      ...asciiBytes("ID3"),
      4,
      0x00,
      0x00,
      ...syncsafe32(gainFrame.length + brokenFrameHeader.length),
    ];
    const tag = new Uint8Array([...header, ...gainFrame, ...brokenFrameHeader]);
    expect(parseId3v2(tag)).toEqual({ gainDb: -6.5 });
  });

  it("does not read a frame body past the TAG's own boundary, even when the buffer physically has more bytes there", () => {
    // A subtler version of the check above: this frame's declared size claims 32
    // bytes, but the tag's own header only declares room for 23 (the encoding byte
    // plus the bare description, no terminator or value). The 9 extra bytes (a null
    // terminator plus "-6.50 dB") really do exist in the buffer right after the
    // declared tag end, standing in for whatever unrelated content (audio data, the
    // next file section) a real file would have there. A parser that bounds a frame
    // against the physical buffer but not against the tag's own declared size reads
    // straight through into that trailing content and reports a tag that was never
    // actually inside the ID3 header.
    const description = asciiBytes("REPLAYGAIN_TRACK_GAIN"); // 22 bytes, no terminator here
    const trailing = [0x00, ...asciiBytes("-6.50 dB")]; // terminator + value, past tagEnd
    const declaredFrameBodyLength = 1 + description.length + trailing.length; // encoding + all of it
    const frame = [
      ...asciiBytes("TXXX"),
      ...syncsafe32(declaredFrameBodyLength),
      0x00,
      0x00,
      0x03, // encoding: UTF-8
      ...description,
    ];
    const header = [
      ...asciiBytes("ID3"),
      4,
      0x00,
      0x00,
      ...syncsafe32(frame.length), // tag ends right after the bare description
    ];
    const tag = new Uint8Array([...header, ...frame, ...trailing]);
    expect(parseId3v2(tag)).toEqual({});
  });
});
