import { describe, expect, it } from "vitest";
import {
  BANDS,
  bandBins,
  bandEdges,
  bandLevels,
  createLadder,
  createNeedle,
  peakDb,
  rmsDb,
  stepLadder,
  stepNeedle,
  vuAngle,
} from "./meters.js";
import { counterDrums, counterValue, FULL_MM, HUB_MM, tapeGeometry } from "./tape.js";

describe("VU meter", () => {
  it("puts -20 and +3 at the ends of the printed arc and 0 in the upper half", () => {
    expect(vuAngle(-20)).toBeCloseTo(-38);
    expect(vuAngle(3)).toBeCloseTo(38);
    expect(vuAngle(0)).toBeGreaterThan(10);
  });

  it("measures RMS and peak in dBFS", () => {
    const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((i / 48) * 2 * Math.PI));
    expect(rmsDb(sine)).toBeCloseTo(-3.01, 1);
    expect(peakDb(sine)).toBeCloseTo(0, 1);
    expect(rmsDb(new Float32Array(16))).toBe(-Infinity);
  });

  it("settles on its target and stays inside the pins", () => {
    const n = createNeedle();
    for (let i = 0; i < 120; i++) stepNeedle(n, 10, 1 / 60);
    expect(n.angle).toBeCloseTo(10, 0);
    for (let i = 0; i < 60; i++) stepNeedle(n, 400, 1 / 60);
    expect(n.angle).toBeLessThanOrEqual(40);
  });
});

describe("LED ladder", () => {
  it("splits the spectrum into contiguous bands around each fader", () => {
    const edges = bandEdges();
    expect(edges).toHaveLength(BANDS.length);
    for (let i = 1; i < edges.length; i++) expect(edges[i][0]).toBeCloseTo(edges[i - 1][1]);
    edges.forEach(([lo, hi], i) => {
      expect(lo).toBeLessThan(BANDS[i]);
      expect(hi).toBeGreaterThan(BANDS[i]);
    });
  });

  it("gives every band at least one bin, even the narrow low ones", () => {
    const bins = bandBins(bandEdges(), 48000, 4096);
    bins.forEach(([s, e]) => expect(e).toBeGreaterThanOrEqual(s));
    expect(bins[0][0]).toBeGreaterThanOrEqual(1);
  });

  it("reads the loudest bin per band onto the ladder", () => {
    const db = new Float32Array(2048).fill(-120);
    const bins = bandBins(bandEdges(), 48000, 4096);
    db[bins[5][0]] = -18;
    const out = bandLevels(db, bins);
    expect(out[5]).toBe(1);
    expect(out[0]).toBe(0);
  });

  it("attacks fast, falls slowly, and holds the peak", () => {
    const ladder = createLadder(1);
    stepLadder(ladder, [1], 0.1);
    expect(ladder.levels[0]).toBe(1);
    stepLadder(ladder, [0], 0.1);
    expect(ladder.levels[0]).toBeCloseTo(0.4);
    expect(ladder.peaks[0]).toBe(1);
    for (let i = 0; i < 10; i++) stepLadder(ladder, [0], 0.1);
    expect(ladder.peaks[0]).toBeLessThan(1);
  });
});

describe("tape", () => {
  it("starts with all the tape on the supply spool and ends on the take-up", () => {
    const start = tapeGeometry(0, 600);
    expect(start.takeup).toBeCloseTo(HUB_MM);
    expect(start.supply).toBeCloseTo(FULL_MM);
    const end = tapeGeometry(600, 600);
    expect(end.takeup).toBeCloseTo(FULL_MM);
    expect(end.supply).toBeCloseTo(HUB_MM);
  });

  it("turns the empty hub faster than the full one", () => {
    const a = tapeGeometry(0, 1800);
    const b = tapeGeometry(10, 1800);
    expect(b.takeupTurns - a.takeupTurns).toBeGreaterThan(b.supplyTurns - a.supplyTurns);
  });

  it("is an empty deck with no tape", () => {
    expect(tapeGeometry(5, 0)).toEqual({
      takeup: HUB_MM,
      supply: HUB_MM,
      takeupTurns: 0,
      supplyTurns: 0,
    });
  });

  it("counts take-up turns from the last reset, wrapping at 1000", () => {
    expect(counterValue(10)).toBe(5);
    expect(counterValue(10, 10)).toBe(0);
    expect(counterValue(0, 2)).toBe(999);
  });

  it("rolls the higher drums only as the lower one passes 9", () => {
    expect(counterDrums(123)).toEqual([1, 2, 3]);
    const [h, t, u] = counterDrums(99.5);
    expect(u).toBeCloseTo(9.5);
    expect(t).toBeCloseTo(9.5);
    expect(h).toBeCloseTo(0.5);
    expect(counterDrums(45.5)[1]).toBe(4);
  });
});
