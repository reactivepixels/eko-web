import { describe, expect, it } from "vitest";
import { createAmpChain, ECHO, SETTINGS, SPEAKER_VOICING } from "./amp-chain.js";
import { createDeckChain, TAPE_CHARACTER } from "./deck-chain.js";
import { fakeContext, reachable } from "./fake-context.js";
import { createExtras, createInputStage } from "./inputs.js";
import { crackle, pinkNoise, saturationCurve, seeded } from "./noise.js";
import { balanceGains, dbToGain, loudnessDb, volumeAngle, volumeDb } from "./taper.js";

const settings = (patch = {}) => ({ ...SETTINGS, bands: [...SETTINGS.bands], ...patch });

describe("volume taper", () => {
  it("follows the printed scale at each mark", () => {
    expect(volumeDb(0)).toBe(-Infinity);
    expect(volumeDb(1)).toBe(-60);
    expect(volumeDb(4)).toBe(-20);
    expect(volumeDb(8)).toBe(0);
    expect(volumeDb(7.5)).toBeCloseTo(-2.5);
  });

  it("is continuous just above infinity and clamps out of range", () => {
    expect(volumeDb(0.01)).toBeLessThan(-89);
    expect(volumeDb(-3)).toBe(-Infinity);
    expect(volumeDb(99)).toBe(0);
  });

  it("maps positions to the knob's 280 degree sweep", () => {
    expect(volumeAngle(0)).toBe(-140);
    expect(volumeAngle(4)).toBe(0);
    expect(volumeAngle(8)).toBe(140);
  });

  it("adds loudness only as the volume comes down", () => {
    expect(loudnessDb(0)).toEqual({ low: 0, high: 0 });
    expect(loudnessDb(-20).low).toBeCloseTo(5);
    expect(loudnessDb(-Infinity)).toEqual({ low: 10, high: 4 });
  });

  it("balances by turning one side down", () => {
    expect(balanceGains(0)).toEqual({ left: 1, right: 1 });
    expect(balanceGains(0.25)).toEqual({ left: 0.75, right: 1 });
    expect(balanceGains(-3)).toEqual({ left: 1, right: 0 });
  });

  it("converts dB to gain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
  });
});

describe("amp chain", () => {
  it("is one connected sub-graph from input to output", () => {
    const ctx = fakeContext();
    const amp = createAmpChain(ctx);
    expect(reachable(amp.input).has(amp.output)).toBe(true);
    expect(amp.output.connections).toEqual([]);
  });

  it("upmixes mono at the input so the splitters always see two channels", () => {
    const amp = createAmpChain(fakeContext());
    expect(amp.input.channelCount).toBe(2);
    expect(amp.input.channelCountMode).toBe("explicit");
    expect(amp.input.channelInterpretation).toBe("speakers");
  });

  it("applies the EQ, and DEFEAT or EQ POWER off flattens it", () => {
    const amp = createAmpChain(fakeContext());
    const bands = [12, 0, 0, 0, 0, 0, 0, 0, 0, -30];
    amp.set(settings({ bands }));
    expect(amp.parts.bands[0].gain.value).toBe(12);
    expect(amp.parts.bands[9].gain.value).toBe(-12);
    amp.set(settings({ bands, eqDefeat: true }));
    expect(amp.parts.bands.every((b) => b.gain.value === 0)).toBe(true);
    amp.set(settings({ bands, eqPower: false }));
    expect(amp.parts.bands[0].gain.value).toBe(0);
  });

  it("folds to mono and balances through the matrix", () => {
    const amp = createAmpChain(fakeContext());
    const g = amp.parts.mat.gains;
    amp.set(settings({ mono: true }));
    expect([g.ll.gain.value, g.rl.gain.value, g.lr.gain.value, g.rr.gain.value]).toEqual([
      0.5, 0.5, 0.5, 0.5,
    ]);
    amp.set(settings({ balance: -0.5 }));
    expect([g.ll.gain.value, g.rr.gain.value]).toEqual([1, 0.5]);
  });

  it("voices speakers B and A+B, and crossfeeds with PHONES in", () => {
    const amp = createAmpChain(fakeContext());
    amp.set(settings({ speakers: "B", phones: true }));
    expect(amp.parts.spkHp.frequency.value).toBe(SPEAKER_VOICING.B.hp);
    expect(amp.parts.spkLp.frequency.value).toBe(SPEAKER_VOICING.B.lp);
    expect(amp.parts.phones.cross[0].gain.value).toBeGreaterThan(0);
    amp.set(settings({ speakers: "nonsense" }));
    expect(amp.parts.spkHp.frequency.value).toBe(SPEAKER_VOICING.A.hp);
    expect(amp.parts.phones.cross[1].gain.value).toBe(0);
  });

  it("sets the echo from TAPE MON and silences it when off", () => {
    const amp = createAmpChain(fakeContext());
    amp.set(settings({ tapeMon: "dub" }));
    expect(amp.parts.mon.delay.delayTime.value).toBe(ECHO.dub.time);
    expect(amp.parts.mon.feedback.gain.value).toBe(ECHO.dub.feedback);
    amp.set(settings({ tapeMon: "off" }));
    expect(amp.parts.mon.wet.gain.value).toBe(0);
    expect(amp.parts.mon.feedback.gain.value).toBe(0);
  });

  it("follows the volume, and mutes for POWER off and while the relay is closed", () => {
    const amp = createAmpChain(fakeContext());
    amp.set(settings({ volume: 4 }));
    expect(amp.parts.master.gain.value).toBeCloseTo(0.1);
    amp.set(settings({ volume: 4, power: false }));
    expect(amp.parts.master.gain.value).toBe(0);
    amp.setRelay(false, settings({ volume: 8 }));
    expect(amp.parts.master.gain.value).toBe(0);
    amp.setRelay(true, settings({ volume: 8 }));
    expect(amp.parts.master.gain.value).toBe(1);
  });

  it("switches the LOW and HIGH filters and the loudness contour", () => {
    const amp = createAmpChain(fakeContext());
    amp.set(settings({ low: true, high: true, loud: true, volume: 4 }));
    expect(amp.parts.lowCut.frequency.value).toBe(60);
    expect(amp.parts.highCut.frequency.value).toBe(7000);
    expect(amp.parts.loudLow.gain.value).toBeCloseTo(5);
    amp.set(settings({ volume: 4 }));
    expect(amp.parts.lowCut.frequency.value).toBeLessThan(20);
    expect(amp.parts.loudLow.gain.value).toBe(0);
  });
});

describe("deck chain", () => {
  it("is a straight wire with DOLBY NR in", () => {
    const ctx = fakeContext();
    const deck = createDeckChain(ctx);
    deck.set({ dolby: true, tapeType: "normal" });
    const gains = ctx.created.filter((n) => n.kind === "gain");
    const into = (g) => g.connections.some((c) => c.target === deck.tap);
    const open = gains.filter((g) => into(g) && g.gain.value > 0);
    expect(open).toHaveLength(1);
    expect(reachable(deck.input).has(deck.output)).toBe(true);
  });

  it("adds each tape type's hiss and saturation with DOLBY NR out", () => {
    const ctx = fakeContext();
    const deck = createDeckChain(ctx);
    deck.set({ dolby: false, tapeType: "metal" });
    const shaper = ctx.created.find((n) => n.kind === "shaper");
    expect(shaper.curve[shaper.curve.length - 1]).toBeCloseTo(
      Math.tanh(TAPE_CHARACTER.metal.drive) / TAPE_CHARACTER.metal.drive,
    );
    const levels = ctx.created.filter((n) => n.kind === "gain").map((g) => g.gain.value);
    expect(levels).toContain(TAPE_CHARACTER.metal.hiss);
    expect(levels).toContain(TAPE_CHARACTER.metal.wow);
  });

  it("starts its own oscillators and hiss source", () => {
    const ctx = fakeContext();
    createDeckChain(ctx);
    const sources = ctx.created.filter((n) => n.kind === "osc" || n.kind === "buffersource");
    expect(sources.length).toBe(3);
    expect(sources.every((s) => s.started)).toBe(true);
  });
});

describe("inputs", () => {
  it("gates the deck off for TUNER and AUX and rolls off its top for PHONO", () => {
    const stage = createInputStage(fakeContext());
    const [tone, gate] = stage.nodes;
    stage.set("tuner");
    expect(gate.gain.value).toBe(0);
    stage.set("phono");
    expect(gate.gain.value).toBe(1);
    expect(tone.frequency.value).toBe(9000);
    stage.set("tape");
    expect(tone.frequency.value).toBe(22000);
  });

  it("crackles only while PHONO is selected and the record turns", () => {
    const ctx = fakeContext();
    const extras = createExtras(ctx);
    const into = (n) => n.connections.some((c) => c.target === extras.output);
    const level = () =>
      ctx.created.filter((n) => n.kind === "gain" && into(n)).map((g) => g.gain.value);
    extras.set("phono", false);
    expect(level().every((v) => v === 0)).toBe(true);
    extras.set("phono", true);
    expect(level().some((v) => v > 0)).toBe(true);
    extras.set("tape", true);
    expect(level().every((v) => v === 0)).toBe(true);
  });

  it("hums on AUX and hisses on TUNER", () => {
    const ctx = fakeContext();
    const extras = createExtras(ctx);
    extras.set("aux", false);
    const into = (n) => n.connections.some((c) => c.target === extras.output);
    const on = () => ctx.created.filter((n) => n.kind === "gain" && into(n) && n.gain.value > 0);
    expect(on()).toHaveLength(1);
    extras.set("tuner", false);
    extras.tick(0.1);
    expect(on().length).toBeGreaterThan(0);
  });
});

describe("noise", () => {
  it("is deterministic for a seed", () => {
    expect(pinkNoise(64, seeded(3))).toEqual(pinkNoise(64, seeded(3)));
    expect(seeded(1)()).not.toBe(seeded(2)());
  });

  it("keeps pink noise and crackle within full scale", () => {
    const pink = pinkNoise(48000);
    expect(Math.max(...pink.map(Math.abs))).toBeLessThan(1);
    const c = crackle(48000, 48000);
    expect(c.some((v) => v !== 0)).toBe(true);
    expect(Math.max(...c.map(Math.abs))).toBeLessThan(1.2);
  });

  it("saturates symmetrically at unity gain for quiet signals and rounds off peaks", () => {
    const n = 2049;
    const curve = saturationCurve(2, n);
    const at = (x) => curve[Math.round(((x + 1) / 2) * (n - 1))];
    expect(at(0.01)).toBeCloseTo(0.01, 3);
    expect(at(-0.5)).toBeCloseTo(-at(0.5));
    expect(at(1)).toBeLessThan(0.6);
  });
});
