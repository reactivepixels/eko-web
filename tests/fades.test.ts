import { describe, it, expect, afterEach } from "vitest";
import { rampTo, DEFAULT_FADE_SECONDS } from "../src/engine/fades";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, MockParam, makeToneBuffer, stubFetch } from "./mock-audio";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

describe("rampTo", () => {
  it("pins the current value then ramps to the target, returning the end time", () => {
    const param = new MockParam();
    param.value = 0.25;
    const end = rampTo(param as unknown as AudioParam, 1, 5, 0.01);

    expect(end).toBeCloseTo(5.01, 6);
    expect(param.scheduled).toEqual([{ value: 0.25, time: 5 }]);
    expect(param.ramps).toEqual([{ value: 1, time: 5.01 }]);
  });

  it("uses a short default so the fade is inaudible", () => {
    expect(DEFAULT_FADE_SECONDS).toBe(0.01);
  });
});

describe("engine fades", () => {
  it("ramps fadeGain up from silence on play", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    const fadeGain = ctx.gains[1]!; // rg, fade, user
    expect(fadeGain.gain.scheduled.at(-1)).toEqual({ value: 0, time: 0 });
    expect(fadeGain.gain.ramps.at(-1)).toEqual({ value: 1, time: DEFAULT_FADE_SECONDS });
  });

  it("ramps down on pause and stops the source at the end of the ramp", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    ctx.currentTime = 0.2;
    engine.pause();

    const fadeGain = ctx.gains[1]!;
    expect(fadeGain.gain.ramps.at(-1)).toEqual({ value: 0, time: 0.2 + DEFAULT_FADE_SECONDS });
    expect(ctx.sources[0]!.stopWhen).toBeCloseTo(0.2 + DEFAULT_FADE_SECONDS, 6);
    // The reported position is where the user pressed pause, not the end of the ramp.
    expect(engine.currentTime).toBeCloseTo(0.2, 3);
  });

  it("honours a custom fadeSeconds", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      fadeSeconds: 0.05,
    });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    expect(ctx.gains[1]!.gain.ramps.at(-1)).toEqual({ value: 1, time: 0.05 });
  });

  it("fades across a seek while playing", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    ctx.currentTime = 0.1;
    const sourcesBefore = ctx.sources.length;
    engine.seek(0.3);

    // The old source is stopped at the ramp end and a new one starts there.
    expect(ctx.sources[sourcesBefore - 1]!.stopWhen).toBeCloseTo(0.1 + DEFAULT_FADE_SECONDS, 6);
    const fresh = ctx.sources[ctx.sources.length - 1]!;
    expect(fresh.startWhen).toBeCloseTo(0.1 + DEFAULT_FADE_SECONDS, 6);
    expect(fresh.startOffset).toBeCloseTo(0.3, 6);
  });

  it("does not click across a seek: the fade-out actually reaches (near) zero at the cut", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    ctx.currentTime = 0.1;
    const rampEnd = 0.1 + DEFAULT_FADE_SECONDS;
    engine.seek(0.3);

    const fadeGain = ctx.gains[1]!; // rg, fade, user
    // Sample just before the cut: if seek's own restart cancelled the fade-out's landing
    // ramp (the bug), the gain never actually ramped down and this reads back near 1 (a
    // click at the cut). A real fade reads back near 0 here.
    expect(fadeGain.gain.valueAt(rampEnd - 0.0005)).toBeLessThan(0.2);
  });

  it("fades out on a manual skip while playing, instead of cutting abruptly", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }, { src: "/b.flac" }]);
    await ready;
    await engine.play();

    ctx.currentTime = 0.15;
    engine.next();

    // The outgoing source is stopped on the ramp's last sample, the same shape pause()
    // and seek() already use, not cut with no `when` (which would click).
    const fadeGain = ctx.gains[1]!;
    expect(fadeGain.gain.ramps.at(-1)).toEqual({ value: 0, time: 0.15 + DEFAULT_FADE_SECONDS });
    expect(ctx.sources[0]!.stopWhen).toBeCloseTo(0.15 + DEFAULT_FADE_SECONDS, 6);
  });
});
