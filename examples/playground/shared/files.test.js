import { describe, expect, it } from "vitest";
import { appendEntries, isAudioFile, kbpsFor, makeDemoLoop, titleFromName } from "./files.js";

describe("isAudioFile", () => {
  it("accepts audio MIME types and known extensions", () => {
    expect(isAudioFile({ name: "a.flac", type: "audio/flac" })).toBe(true);
    expect(isAudioFile({ name: "b.mp3", type: "" })).toBe(true);
    expect(isAudioFile({ name: "c.OGG", type: "" })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isAudioFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isAudioFile({ name: "cover.png", type: "image/png" })).toBe(false);
    expect(isAudioFile({ name: "noext", type: "" })).toBe(false);
  });
});

describe("titleFromName", () => {
  it("drops the extension and keeps the rest", () => {
    expect(titleFromName("Massive Attack - Teardrop.flac")).toBe("Massive Attack - Teardrop");
    expect(titleFromName("track.01.final.mp3")).toBe("track.01.final");
    expect(titleFromName("noext")).toBe("noext");
  });
  it("turns underscores into spaces", () => {
    expect(titleFromName("Aphex_Twin_-_Avril_14th.ogg")).toBe("Aphex Twin - Avril 14th");
  });
});

describe("kbpsFor", () => {
  it("computes the average bitrate", () => {
    expect(kbpsFor(4_000_000, 100)).toBe(320);
  });
  it("returns null when the duration is unknown", () => {
    expect(kbpsFor(4_000_000, 0)).toBeNull();
    expect(kbpsFor(4_000_000, NaN)).toBeNull();
  });
});

describe("makeDemoLoop", () => {
  it("is 8 s of 48 kHz audio that starts and ends silent, so copies join with no seam", async () => {
    const view = new DataView(await makeDemoLoop().arrayBuffer());
    const frames = view.getUint32(40, true) / 2;
    expect(frames).toBe(48000 * 8);
    const sample = (i) => view.getInt16(44 + i * 2, true);
    expect(Math.abs(sample(0))).toBeLessThan(40);
    expect(Math.abs(sample(frames - 1))).toBeLessThan(40);
    let peak = 0;
    for (let i = 0; i < frames; i += 7) peak = Math.max(peak, Math.abs(sample(i)));
    expect(peak).toBeGreaterThan(8000);
    expect(peak).toBeLessThan(32767);
  });
});

describe("appendEntries", () => {
  it("appends without mutating, so the playing list is untouched", () => {
    const a = [{ title: "one" }];
    const out = appendEntries(a, [{ title: "two" }]);
    expect(out.map((e) => e.title)).toEqual(["one", "two"]);
    expect(a).toHaveLength(1);
  });
});
