import { describe, it, expect } from "vitest";
import {
  measureLoudnessLufs,
  samplePeak,
  computeNormalizationGain,
  dbToLinear,
  linearToDb,
} from "../src/engine/loudness";

/** Generate a sine tone as a single channel. */
function sine(freq: number, amplitude: number, seconds: number, fs = 48000): Float32Array {
  const n = Math.floor(seconds * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

describe("dB <-> linear", () => {
  it("0 dB is unity", () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 6);
  });
  it("+6 dB ~ x2, -6 dB ~ x0.5", () => {
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
  });
  it("round-trips", () => {
    expect(linearToDb(dbToLinear(-14))).toBeCloseTo(-14, 6);
  });
});

describe("samplePeak", () => {
  it("finds the max absolute sample across channels", () => {
    expect(samplePeak([new Float32Array([0.1, -0.8, 0.3]), new Float32Array([0.2])])).toBeCloseTo(
      0.8,
      6,
    );
  });
  it("is 0 for silence", () => {
    expect(samplePeak([new Float32Array([0, 0, 0])])).toBe(0);
  });
});

describe("measureLoudnessLufs", () => {
  it("returns -Infinity for silence", () => {
    expect(measureLoudnessLufs([new Float32Array(1000)], 48000)).toBe(-Infinity);
  });
  it("returns -Infinity for empty input", () => {
    expect(measureLoudnessLufs([], 48000)).toBe(-Infinity);
  });
  it("a louder tone measures higher LUFS than a quieter one (monotonic)", () => {
    const loud = measureLoudnessLufs([sine(1000, 0.5, 1)], 48000);
    const quiet = measureLoudnessLufs([sine(1000, 0.05, 1)], 48000);
    expect(loud).toBeGreaterThan(quiet);
    // ~20 dB amplitude difference → ~20 LUFS difference.
    expect(loud - quiet).toBeGreaterThan(15);
  });
  it("is sample-rate robust (44.1k vs 48k within ~1 LUFS for the same tone)", () => {
    const at48 = measureLoudnessLufs([sine(1000, 0.3, 1, 48000)], 48000);
    const at441 = measureLoudnessLufs([sine(1000, 0.3, 1, 44100)], 44100);
    expect(Math.abs(at48 - at441)).toBeLessThan(1);
  });
});

describe("computeNormalizationGain", () => {
  it("is unity for silence (never boost nothing)", () => {
    expect(computeNormalizationGain(-Infinity, -16, 0)).toBe(1);
  });

  it("is ~unity when already at target", () => {
    expect(computeNormalizationGain(-16, -16, 0.9)).toBeCloseTo(1, 6);
  });

  it("cuts a track that's louder than target", () => {
    // -8 LUFS vs -16 target → -8 dB ≈ 0.398x; peak 1.0 doesn't constrain a cut.
    expect(computeNormalizationGain(-8, -16, 1.0)).toBeCloseTo(dbToLinear(-8), 6);
  });

  it("boosts a quiet track but CLAMPS so the peak can't clip", () => {
    // -30 LUFS vs -16 target → +14 dB ≈ 5.01x, but peak 0.5 caps gain at 1/0.5 = 2.0.
    const gain = computeNormalizationGain(-30, -16, 0.5);
    expect(gain).toBeCloseTo(2.0, 6);
    expect(gain * 0.5).toBeLessThanOrEqual(1.0); // no clipping
  });

  it("applies the full boost when the peak leaves headroom", () => {
    // +6 dB needed (≈2x), peak 0.1 allows up to 10x → not clamped.
    expect(computeNormalizationGain(-22, -16, 0.1)).toBeCloseTo(dbToLinear(6), 6);
  });
});
