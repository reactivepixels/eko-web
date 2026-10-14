import { describe, expect, it } from "vitest";
import { formatTime, GLYPHS, glyphIndex, textWidth } from "./text.js";

describe("bitmap text", () => {
  it("covers the characters Winamp shows", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .:-()*/'&_[]!?+,") {
      expect(GLYPHS.includes(ch), ch).toBe(true);
    }
  });
  it("folds lowercase and falls back to space", () => {
    expect(glyphIndex("a")).toBe(glyphIndex("A"));
    expect(glyphIndex("é")).toBe(glyphIndex(" "));
  });
  it("is 5 px per character", () => {
    expect(textWidth("ABC")).toBe(15);
  });
});

describe("formatTime", () => {
  it("formats m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3600)).toBe("60:00");
  });
  it("treats unknown durations as zero", () => {
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(Infinity)).toBe("0:00");
  });
});
