import { describe, it, expect } from "vitest";
import { trackEndTime, remaining, elapsed } from "../src/engine/scheduling";

describe("trackEndTime", () => {
  it("is start + full duration when played from the beginning", () => {
    expect(trackEndTime(10, 180, 0)).toBe(190);
  });
  it("accounts for a non-zero start offset (e.g. after a seek)", () => {
    // started at ctx=10, a 180s track from 30s in → 150s remain → ends at 160.
    expect(trackEndTime(10, 180, 30)).toBe(160);
  });
  it("never schedules in the past for an over-run offset", () => {
    expect(trackEndTime(10, 180, 200)).toBe(10);
  });
});

describe("remaining", () => {
  it("is the gap between now and the end", () => {
    expect(remaining(190, 175)).toBe(15);
  });
  it("clamps to 0 past the end", () => {
    expect(remaining(190, 200)).toBe(0);
  });
});

describe("elapsed", () => {
  it("tracks position from the start offset", () => {
    // started ctx=10 from offset 5, duration 180, now=12 → 5 + 2 = 7.
    expect(elapsed(10, 5, 180, 12)).toBe(7);
  });
  it("clamps to the duration", () => {
    expect(elapsed(10, 0, 180, 999)).toBe(180);
  });
  it("clamps to 0", () => {
    expect(elapsed(10, 0, 180, 5)).toBe(0);
  });
});
