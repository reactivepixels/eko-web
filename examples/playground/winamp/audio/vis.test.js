import { describe, expect, it } from "vitest";
import { BAR_COUNT, barRanges, binsToBars, createPeaks, scopePoints, VIS_HEIGHT } from "./vis.js";

describe("barRanges", () => {
  const ranges = barRanges(48000, 2048);
  it("gives 19 in-bounds, non-empty, ordered ranges", () => {
    expect(ranges).toHaveLength(BAR_COUNT);
    let prev = 0;
    for (const [a, b] of ranges) {
      expect(a).toBeGreaterThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(a);
      expect(b).toBeLessThan(1024);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    const widths = ranges.map(([a, b]) => b - a);
    expect(widths[18]).toBeGreaterThan(widths[0]);
  });
  it("starts near 60 Hz and ends near 16 kHz", () => {
    const hz = (bin) => (bin * 48000) / 2048;
    expect(hz(ranges[0][0])).toBeLessThan(80);
    expect(hz(ranges[18][1])).toBeGreaterThan(14000);
  });
  it("works at 44.1 kHz too", () => {
    expect(barRanges(44100, 2048)).toHaveLength(BAR_COUNT);
  });
});

describe("binsToBars", () => {
  it("maps full scale to the vis height and silence to zero", () => {
    const ranges = barRanges(48000, 2048);
    const out = new Float32Array(BAR_COUNT);
    binsToBars(new Uint8Array(1024).fill(255), ranges, out);
    expect([...out].every((v) => v === VIS_HEIGHT)).toBe(true);
    binsToBars(new Uint8Array(1024), ranges, out);
    expect([...out].every((v) => v === 0)).toBe(true);
  });
});

describe("createPeaks", () => {
  it("holds a peak, then lets it fall", () => {
    const peaks = createPeaks();
    const bars = new Float32Array(BAR_COUNT);
    bars[0] = 12;
    expect(peaks.update(bars, 1 / 60)[0]).toBe(12);
    bars[0] = 0;
    expect(peaks.update(bars, 0.3)[0]).toBe(12);
    let p = 12;
    for (let i = 0; i < 120; i++) p = peaks.update(bars, 1 / 60)[0];
    expect(p).toBeLessThan(12);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe("scopePoints", () => {
  it("centres silence and stays in bounds", () => {
    const out = new Uint8Array(76);
    scopePoints(new Uint8Array(2048).fill(128), out);
    expect([...out].every((y) => y === 8)).toBe(true);
    scopePoints(new Uint8Array(2048).fill(255), out);
    expect([...out].every((y) => y >= 0 && y <= 15)).toBe(true);
    scopePoints(new Uint8Array(2048).fill(0), out);
    expect([...out].every((y) => y === 0)).toBe(true);
  });
});
