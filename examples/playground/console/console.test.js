import { describe, expect, it } from "vitest";
import {
  barSeconds,
  bassHz,
  clonePattern,
  nextPhrase,
  PATTERNS,
  phraseSeconds,
  pressStep,
  STEPS,
  stepsBetween,
  stepTime,
  VOICES,
} from "./audio/sequencer.js";
import { audibility, faderDb, faderGain } from "./audio/strip.js";
import { foldLoop, renderStem, STEMS } from "./audio/stems.js";

describe("clock", () => {
  it("runs sixteenths at the tempo, with swing on the off-beats only", () => {
    expect(barSeconds(120)).toBe(2);
    expect(stepTime(0, 4, 120)).toBeCloseTo(0.5);
    expect(stepTime(0, 1, 120, 0.5)).toBeCloseTo(0.125 + 0.0625);
    expect(stepTime(0, 2, 120, 0.5)).toBeCloseTo(0.25);
  });

  it("lists exactly the steps inside a window, once each, across windows", () => {
    const seen = [];
    for (let t = 0; t < 4; t += 0.025) seen.push(...stepsBetween(0, t, t + 0.025, 124, 0.3));
    const idx = seen.map((s) => s.index);
    expect(new Set(idx).size).toBe(idx.length);
    expect(idx).toEqual([...Array(idx.length).keys()]);
    expect(seen[17].step).toBe(1);
  });

  it("finds the next phrase boundary, leaving a margin", () => {
    const p = phraseSeconds(120);
    expect(p).toBe(16);
    expect(nextPhrase(0, 1, 120)).toBe(16);
    expect(nextPhrase(0, 15.5, 120, 1)).toBe(32);
    expect(nextPhrase(0, 0, 120)).toBe(0);
  });
});

describe("patterns", () => {
  it("are all complete: every voice, sixteen steps", () => {
    for (const p of Object.values(PATTERNS)) {
      for (const v of VOICES) expect(p[v]).toHaveLength(STEPS);
    }
  });

  it("A is the Night Bus groove", () => {
    const a = PATTERNS.A;
    expect(a.bd.map(Boolean).join("")).toBe(
      "true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false".replace(
        /,/g,
        "",
      ),
    );
    expect(a.bl.filter(Boolean)).toEqual(["A", "A", "C", "D", "E", "D", "C", "G"]);
  });

  it("toggles drum steps and cycles bass notes, on a copy", () => {
    const p = clonePattern(PATTERNS.A);
    expect(pressStep(p, "bd", 1)).toBe(true);
    expect(pressStep(p, "bd", 1)).toBe(null);
    expect(pressStep(p, "bl", 1)).toBe("A");
    expect(pressStep(p, "bl", 1)).toBe("C");
    p.bl[3] = "G";
    expect(pressStep(p, "bl", 3)).toBe(null);
    expect(PATTERNS.A.bd[1]).toBe(null);
  });

  it("tunes the bass line from A1", () => {
    expect(bassHz("A")).toBe(55);
    expect(bassHz("E")).toBeCloseTo(82.41, 1);
  });
});

describe("mixer maths", () => {
  it("puts unity at three quarters of the throw and +10 dB at the top", () => {
    expect(faderGain(0)).toBe(0);
    expect(faderDb(0.75)).toBeCloseTo(0);
    expect(faderDb(1)).toBeCloseTo(10);
    expect(faderDb(0.375)).toBeCloseTo(-30);
  });

  it("mutes always win, and any solo silences the rest", () => {
    const s = (mute, solo) => ({ mute, solo });
    expect(audibility([s(false, false), s(true, false)])).toEqual([true, false]);
    expect(audibility([s(false, true), s(false, false), s(true, true)])).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("stems", () => {
  it("folds the overhang back onto the start", () => {
    expect([...foldLoop(Float32Array.from([1, 2, 3, 4, 5]), 3)]).toEqual([5, 7, 3]);
  });

  it("render as exact eight-bar loops at the tempo", () => {
    const rate = 4000;
    const s = renderStem(STEMS[0], 120, rate);
    expect(s.length).toBe(16 * rate);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(STEMS[0].level, 2);
  });
});
