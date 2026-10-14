import { describe, expect, it } from "vitest";
import { bandEnergy, createAnalysis, stepAnalysis, tempo } from "./audio/analysis.js";
import { blend, DEFAULTS, evaluate, pickNext, PRESETS } from "./presets.js";

const frame = (over = {}) => ({
  t: 3,
  bass: 1,
  mid: 1,
  treb: 1,
  bass_att: 1,
  mid_att: 1,
  treb_att: 1,
  beat: false,
  ...over,
});

describe("analysis", () => {
  it("measures band power from analyser bytes", () => {
    const bytes = new Uint8Array(1024);
    bytes.fill(255, 0, 8);
    // 48 kHz / 2048 = 23.4 Hz a bin: bins 1..6 are the bass band.
    expect(bandEnergy(bytes, 48000, 2048, [20, 150])).toBeCloseTo(1, 1);
    expect(bandEnergy(bytes, 48000, 2048, [2000, 11000])).toBe(0);
  });

  it("settles each band near 1.0 whatever the level", () => {
    const st = createAnalysis();
    for (let i = 0; i < 400; i++)
      stepAnalysis(st, { bass: 0.2, mid: 0.05, treb: 0.01 }, 1 / 60, i / 60);
    expect(st.now.bass).toBeCloseTo(1, 2);
    expect(st.att.treb).toBeCloseTo(1, 2);
  });

  it("rests at 1 in silence instead of amplifying nothing", () => {
    const st = createAnalysis();
    for (let i = 0; i < 60; i++) stepAnalysis(st, { bass: 0, mid: 0, treb: 0 }, 1 / 60, i / 60);
    expect(st.now).toEqual({ bass: 1, mid: 1, treb: 1 });
    expect(st.beat).toBe(false);
  });

  it("rests at 1 straight after the music stops, and does not lurch when it fades in", () => {
    const st = createAnalysis();
    for (let i = 0; i < 300; i++)
      stepAnalysis(st, { bass: 0.3, mid: 0.1, treb: 0.05 }, 1 / 60, i / 60);
    stepAnalysis(st, { bass: 0, mid: 0, treb: 0 }, 1 / 60, 5);
    expect(st.now.bass).toBe(1);
    let peak = 0;
    for (let i = 1; i <= 180; i++) {
      const level = 0.3 * (i / 180);
      stepAnalysis(st, { bass: level, mid: level, treb: level }, 1 / 60, 5 + i / 60);
      peak = Math.max(peak, st.now.bass);
    }
    expect(peak).toBeLessThan(2.2);
  });

  it("finds beats on bass hits and the tempo between them", () => {
    const st = createAnalysis();
    let beats = 0;
    for (let i = 0; i < 60 * 8; i++) {
      const t = i / 60;
      // A kick every 0.5 s (120 bpm), lasting two frames.
      const hit = Math.round(t * 60) % 30 < 2;
      stepAnalysis(st, { bass: hit ? 0.6 : 0.1, mid: 0.1, treb: 0.1 }, 1 / 60, t);
      if (st.beat) beats++;
    }
    expect(beats).toBeGreaterThan(10);
    expect(st.bpm).toBe(120);
  });

  it("folds tempo into 80..160", () => {
    expect(tempo([1, 1, 1])).toBe(120);
    expect(tempo([0.25, 0.25, 0.25])).toBe(120);
    expect(tempo([0.5])).toBe(0);
  });
});

describe("presets", () => {
  it("each produce every parameter, with sane ranges", () => {
    for (const p of PRESETS) {
      for (const f of [frame(), frame({ bass: 3, bass_att: 3, beat: true }), frame({ t: 1000 })]) {
        const v = evaluate(p, f);
        expect(Object.keys(v).sort()).toEqual(Object.keys(DEFAULTS).sort());
        expect(v.decay).toBeGreaterThan(0.85);
        expect(v.decay).toBeLessThan(1);
        expect(v.zoom).toBeGreaterThan(0.9);
        expect(v.zoom).toBeLessThan(1.2);
        expect(v.waveA).toHaveLength(3);
      }
    }
  });

  it("have unique names", () => {
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });

  it("blend numbers smoothly and switch shapes at the midpoint", () => {
    const a = evaluate(PRESETS[0], frame());
    // ion_storm: different decay and wave shape from the ember tunnel.
    const b = evaluate(PRESETS[2], frame());
    expect(blend(a, b, 0).zoom).toBeCloseTo(a.zoom);
    expect(blend(a, b, 1).zoom).toBeCloseTo(b.zoom);
    const mid = blend(a, b, 0.5).decay;
    expect(mid).toBeGreaterThan(Math.min(a.decay, b.decay));
    expect(mid).toBeLessThan(Math.max(a.decay, b.decay));
    expect(blend(a, b, 0.2).wave).toBe(a.wave);
    expect(blend(a, b, 0.8).wave).toBe(b.wave);
    expect(blend(a, b, 0.5).waveAlpha).toBeLessThan(a.waveAlpha);
  });

  it("never picks the current preset next", () => {
    for (let i = 0; i < 50; i++) expect(pickNext(2, () => i / 50)).not.toBe(2);
    expect(pickNext(0, () => 0.999)).toBe(PRESETS.length - 1);
  });
});
