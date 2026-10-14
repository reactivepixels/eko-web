import { describe, expect, it } from "vitest";
import { createEqChain, dbToGain, EQ_FREQS, PRESETS } from "./eq-chain.js";

const param = (v = 0) => ({ value: v });
function fakeCtx() {
  return {
    createGain: () => ({ kind: "gain", gain: param(1) }),
    createBiquadFilter: () => ({
      kind: "biquad",
      type: "peaking",
      frequency: param(),
      Q: param(1),
      gain: param(),
    }),
    createStereoPanner: () => ({ kind: "panner", pan: param() }),
  };
}

describe("createEqChain", () => {
  it("builds preamp, ten filters at Winamp's bands, then the panner", () => {
    const eq = createEqChain(fakeCtx());
    const n = eq.nodes();
    expect(n).toHaveLength(12);
    expect(n[0].kind).toBe("gain");
    expect(n[11].kind).toBe("panner");
    expect(n.slice(1, 11).map((f) => f.frequency.value)).toEqual(EQ_FREQS);
    expect(n[1].type).toBe("lowshelf");
    expect(n[10].type).toBe("highshelf");
    expect(n.slice(2, 10).every((f) => f.type === "peaking")).toBe(true);
  });

  it("clamps band and preamp to +/-12 dB", () => {
    const eq = createEqChain(fakeCtx());
    eq.setBand(3, 40);
    eq.setPreamp(-40);
    expect(eq.nodes()[4].gain.value).toBe(12);
    expect(eq.state().preamp).toBe(-12);
    expect(eq.nodes()[0].gain.value).toBeCloseTo(dbToGain(-12));
  });

  it("off leaves only the panner in the chain, and keeps the settings", () => {
    const eq = createEqChain(fakeCtx());
    eq.setBand(0, 6);
    eq.setOn(false);
    expect(eq.nodes().map((x) => x.kind)).toEqual(["panner"]);
    eq.setOn(true);
    expect(eq.state().bands[0]).toBe(6);
  });

  it("applies presets and clamps balance", () => {
    const eq = createEqChain(fakeCtx());
    eq.applyPreset("Rock");
    expect(eq.state().bands).toEqual(PRESETS.Rock.bands);
    eq.setBalance(-2);
    expect(eq.nodes()[11].pan.value).toBe(-1);
  });

  it("ignores an unknown preset", () => {
    const eq = createEqChain(fakeCtx());
    eq.setBand(2, 4);
    eq.applyPreset("Nope");
    expect(eq.state().bands[2]).toBe(4);
  });
});

describe("dbToGain", () => {
  it("maps 0 dB to unity and 6 dB to about 2x", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 2);
  });
});
