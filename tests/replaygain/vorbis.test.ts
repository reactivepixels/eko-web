import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseVorbisComments } from "../../src/replaygain/vorbis";

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/replaygain/${name}`, import.meta.url)));

/**
 * Replaces one occurrence of an ASCII substring in a copy of `bytes` with another of
 * the exact same length, so no length-prefixed field elsewhere in the file needs to be
 * patched too. Throws if the substring is missing or ambiguous, so a fixture change
 * that breaks the assumption fails loudly instead of silently mutating the wrong bytes.
 */
function replaceAsciiOnce(bytes: Uint8Array, find: string, replace: string): Uint8Array {
  if (find.length !== replace.length) {
    throw new Error("replaceAsciiOnce requires equal-length strings");
  }
  let at = -1;
  for (let i = 0; i + find.length <= bytes.length; i++) {
    let matches = true;
    for (let j = 0; j < find.length; j++) {
      if (bytes[i + j] !== find.charCodeAt(j)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      if (at !== -1) throw new Error(`"${find}" occurs more than once in the fixture`);
      at = i;
    }
  }
  if (at === -1) throw new Error(`"${find}" not found in the fixture`);

  const mutated = bytes.slice();
  for (let j = 0; j < replace.length; j++) {
    mutated[at + j] = replace.charCodeAt(j);
  }
  return mutated;
}

describe("vorbis comments", () => {
  it("reads gain and peak from a real FLAC", () => {
    expect(parseVorbisComments(load("tone.flac"))).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  /**
   * Two real Ogg files, because the comment block is reached by a different route in each.
   * Ogg Vorbis carries it in a packet that starts with the byte 0x03 followed by "vorbis";
   * Ogg FLAC carries a FLAC metadata block inside the Ogg framing instead, with no such
   * signature. A parser that only handles one of them passes half of what people will
   * actually hand it, and both of these are files ffmpeg produces by default for .ogg.
   */
  it("reads gain and peak from a real Ogg Vorbis file", () => {
    expect(parseVorbisComments(load("tone-vorbis.ogg"))).toEqual({
      gainDb: -6.5,
      peak: 0.988525,
    });
  });

  it("reads gain and peak from a real Ogg FLAC file", () => {
    expect(parseVorbisComments(load("tone-oggflac.ogg"))).toEqual({
      gainDb: -6.5,
      peak: 0.988525,
    });
  });

  it("returns an empty result rather than throwing on bytes that are not a container", () => {
    expect(parseVorbisComments(new Uint8Array([1, 2, 3, 4]))).toEqual({});
  });

  it("ignores a truncated comment block instead of reading past the end", () => {
    const flac = load("tone.flac");
    expect(parseVorbisComments(flac.slice(0, 40))).toEqual({});
  });

  it("returns {} when the VORBIS_COMMENT block's own declared length runs past the buffer", () => {
    // Byte 42 of the fixture is the VORBIS_COMMENT block header (type 4, length 114,
    // body starting at 46). Slicing at 50 keeps the header intact but cuts the body
    // far short of its declared end, which must be caught before reading any of it.
    const flac = load("tone.flac");
    expect(parseVorbisComments(flac.slice(0, 50))).toEqual({});
  });

  it("does not read a comment value truncated inside its own declared length as a shorter one", () => {
    // The REPLAYGAIN_TRACK_PEAK entry runs from byte 105 to 134 ("...=0.988525").
    // Cutting the file at 132 leaves the value's bytes physically present only up to
    // "0.988": if the block-length bounds check were skipped, a naive reader could
    // silently accept the clamped, truncated value as a real (wrong) reading instead
    // of rejecting the whole block, which is the failure this guards against.
    const flac = load("tone.flac");
    expect(parseVorbisComments(flac.slice(0, 132))).toEqual({});
  });

  it("matches a lower-case key the same as upper case", () => {
    const flac = load("tone.flac");
    const mutated = replaceAsciiOnce(flac, "REPLAYGAIN_TRACK_GAIN", "replaygain_track_gain");
    expect(parseVorbisComments(mutated)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("treats a gain value that does not parse as a number as absent, not zero", () => {
    const flac = load("tone.flac");
    const mutated = replaceAsciiOnce(flac, "-6.50 dB", "xx.xx dB");
    expect(parseVorbisComments(mutated)).toEqual({ peak: 0.988525 });
  });
});
