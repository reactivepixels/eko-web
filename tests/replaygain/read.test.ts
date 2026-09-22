import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseReplayGain, readReplayGain } from "../../src/replaygain/index";
import { buildApev2 } from "../fixtures/replaygain/build";
import * as vorbisModule from "../../src/replaygain/vorbis";
import * as id3Module from "../../src/replaygain/id3v2";
import * as apev2Module from "../../src/replaygain/apev2";
import * as mp4Module from "../../src/replaygain/mp4";

/**
 * Tests the two public entry points this subpath ships: `parseReplayGain` (pure
 * sniff + dispatch across the four container parsers, no IO) and `readReplayGain`
 * (the `string | ArrayBuffer` entry that either parses in-memory bytes directly or,
 * for a URL, hands off to `fetch-range.ts`'s Range-aware fetcher, tested on its own
 * terms in fetch-range.test.ts).
 */

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/replaygain/${name}`, import.meta.url)));

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** Syncsafe 28-bit encoding (7 bits per byte): ID3v2's header size field, both
 * versions. Mirrors id3v2.test.ts's own helper of the same name. */
function syncsafe32(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

/**
 * Builds a minimal ID3v2.4 tag: an empty tag (no frames at all) when `gainDb` is
 * omitted, or a single TXXX ReplayGain-track-gain frame when it isn't. This is just
 * enough to make `parseReplayGain` sniff the leading "ID3" magic and hand off to
 * `parseId3v2`, which is already thoroughly tested (real + hand-built fixtures) in
 * id3v2.test.ts. This file only needs an ID3 tag that either does or doesn't carry a
 * gain frame, to exercise DISPATCH and the ID3-vs-APEv2 preference rule, not ID3v2
 * parsing itself.
 */
function buildId3Tag(gainDb?: number): Uint8Array {
  if (gainDb === undefined) {
    return new Uint8Array([...asciiBytes("ID3"), 0x04, 0x00, 0x00, ...syncsafe32(0)]);
  }
  const value = `${gainDb.toFixed(2)} dB`;
  const description = "replaygain_track_gain";
  const frameBody = [0x03 /* UTF-8 */, ...asciiBytes(description), 0x00, ...asciiBytes(value)];
  const frame = [...asciiBytes("TXXX"), ...syncsafe32(frameBody.length), 0x00, 0x00, ...frameBody];
  return new Uint8Array([
    ...asciiBytes("ID3"),
    0x04,
    0x00,
    0x00,
    ...syncsafe32(frame.length),
    ...frame,
  ]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("parseReplayGain: container sniffing and dispatch", () => {
  it("dispatches fLaC magic to the Vorbis comment parser", () => {
    expect(parseReplayGain(load("tone.flac"))).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("dispatches a real Ogg Vorbis file's OggS magic to the Vorbis comment parser", () => {
    expect(parseReplayGain(load("tone-vorbis.ogg"))).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("dispatches a real Ogg FLAC file's OggS magic to the Vorbis comment parser", () => {
    expect(parseReplayGain(load("tone-oggflac.ogg"))).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("dispatches ID3 magic to the ID3v2 parser", () => {
    expect(parseReplayGain(load("tone.mp3"))).toEqual({ gainDb: -6.5 });
  });

  it("dispatches APETAGEX magic (footer-only, no ID3 present) to the APEv2 parser", () => {
    const tag = buildApev2(
      { replaygain_track_gain: "-6.50 dB", replaygain_track_peak: "0.988525" },
      { footerOnly: true },
    );
    expect(parseReplayGain(tag)).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("dispatches ftyp-at-offset-4 magic to the MP4 parser", () => {
    expect(parseReplayGain(load("tone-keys.m4a"))).toEqual({ gainDb: -6.5, peak: 0.988525 });
  });

  it("returns {} for bytes matching no recognized container magic", () => {
    const junk = new Uint8Array(200);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) % 256;
    expect(parseReplayGain(junk)).toEqual({});
  });

  it("calls none of the four container parsers for bytes matching no recognized magic", () => {
    // The previous test proves the RESULT is {}; on its own that's satisfied just as
    // well by a dispatcher that speculatively tries a parser anyway (every one of the
    // four already safely returns {} on bytes it doesn't recognize, so a mutated
    // "call parseMp4 no matter what" dispatcher would pass that assertion too). This
    // test proves the DISPATCH itself: for genuinely unrecognized bytes, no parser is
    // invoked at all.
    const vorbisSpy = vi.spyOn(vorbisModule, "parseVorbisComments");
    const id3Spy = vi.spyOn(id3Module, "parseId3v2");
    const apeSpy = vi.spyOn(apev2Module, "parseApev2");
    const mp4Spy = vi.spyOn(mp4Module, "parseMp4");
    try {
      const junk = new Uint8Array(200);
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) % 256;
      expect(parseReplayGain(junk)).toEqual({});
      expect(vorbisSpy).not.toHaveBeenCalled();
      expect(id3Spy).not.toHaveBeenCalled();
      expect(apeSpy).not.toHaveBeenCalled();
      expect(mp4Spy).not.toHaveBeenCalled();
    } finally {
      vorbisSpy.mockRestore();
      id3Spy.mockRestore();
      apeSpy.mockRestore();
      mp4Spy.mockRestore();
    }
  });

  it("falls back to an APEv2 footer when ID3v2 is present but carries no ReplayGain frame", () => {
    // The common real-world shape this dispatch rule exists for: an MP3 with BOTH an
    // ID3v2 header (here, deliberately empty: no TXXX frame at all) and an APEv2
    // footer. ID3 is sniffed first (it's the front tag), finds nothing, and the
    // dispatcher must not stop there.
    const apeTag = buildApev2({ replaygain_track_gain: "-9.00 dB" }, { footerOnly: true });
    const bytes = concatBytes(buildId3Tag(), apeTag);
    expect(parseReplayGain(bytes)).toEqual({ gainDb: -9 });
  });

  it("prefers ID3v2's own gain over a differing APEv2 footer value when ID3v2 DOES carry a frame", () => {
    const apeTag = buildApev2({ replaygain_track_gain: "-9.00 dB" }, { footerOnly: true });
    const bytes = concatBytes(buildId3Tag(-3), apeTag);
    expect(parseReplayGain(bytes)).toEqual({ gainDb: -3 });
  });

  it("returns {} for a tail fragment, even one carrying real MP4 tags: the public contract sniffs only from the start", () => {
    // tone-keys.m4a's moov sits at [1329, 2301) and mdat (which precedes it) at
    // [36, 1329) (see mp4.test.ts's dumped atom tree). Slicing from partway through
    // mdat gives bytes with no magic at offset 0 or offset 4, and no atom boundary at
    // the start: exactly what a Range fetcher's tail request returns for a
    // non-faststart file. `parseReplayGain` must not go looking for a
    // fragment-tolerant reading of this; that is `fetch-range.ts`'s job (tested in
    // fetch-range.test.ts), which does not sniff the tail bytes at all.
    const wholeFile = load("tone-keys.m4a");
    const tailFragment = wholeFile.slice(700);
    expect(parseReplayGain(tailFragment)).toEqual({});
  });
});

describe("readReplayGain(ArrayBuffer): parses in-memory bytes directly, no IO", () => {
  it("parses an in-memory buffer without touching fetch", async () => {
    const bytes = load("tone.flac");
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const tags = await readReplayGain(buffer);
      expect(tags).toEqual({ gainDb: -6.5, peak: 0.988525 });
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves to {} for an ArrayBuffer with no recognized tag, rather than rejecting", async () => {
    const junk = new ArrayBuffer(64);
    await expect(readReplayGain(junk)).resolves.toEqual({});
  });
});

describe("readReplayGain(url): wired to the Range fetcher", () => {
  it("resolves the URL form through a Range-fetched, sniffed parse", async () => {
    const bytes = load("tone.flac");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        status: 206,
        arrayBuffer: async () => bytes.slice().buffer,
      }) as unknown as Response) as typeof fetch;
    try {
      const tags = await readReplayGain("https://example.test/tone.flac");
      expect(tags).toEqual({ gainDb: -6.5, peak: 0.988525 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves to {} rather than rejecting when the network fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as typeof fetch;
    try {
      await expect(readReplayGain("https://example.test/track.mp3")).resolves.toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
