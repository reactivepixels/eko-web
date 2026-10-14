import { describe, expect, it } from "vitest";
import { renderSet, SET_MARKS, SET_SECONDS, setFiles } from "./synth.js";

describe("the demo set", () => {
  const rate = 4000;
  const set = renderSet(rate);

  it("is one continuous, normalized piece", () => {
    expect(set.length).toBe(rate * SET_SECONDS);
    let peak = 0;
    for (const v of set) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.707, 2);
  });

  it("is never silent at a track mark", () => {
    for (const mark of SET_MARKS.slice(1)) {
      const at = mark * rate;
      const near = set.subarray(at - 20, at + 20);
      expect(Math.max(...near.map(Math.abs))).toBeGreaterThan(0.001);
    }
  });

  it("cuts into four WAV files that add back up to the whole", () => {
    const files = setFiles(rate);
    expect(files).toHaveLength(4);
    const bytes = files.reduce((n, f) => n + f.size - 44, 0);
    expect(bytes).toBe(rate * SET_SECONDS * 2);
    expect(files[0].name).toMatch(/^EKO - Ember Set I\./);
  });
});
