import { describe, it, expect, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, MockGainNode, makeToneBuffer, stubFetch } from "./mock-audio";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function setup(options = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5, 4);
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, ...options });
  return { ctx, engine };
}

describe("destination", () => {
  it("routes the output into the node given instead of the speakers", async () => {
    restore = stubFetch();
    const bus = new MockGainNode();
    const { ctx, engine } = setup({ destination: bus });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    const userGain = ctx.gains[2]!;
    expect(userGain.connections).toEqual([bus]);
    // The analyser, once asked for, still sits on the way out.
    const analyser = engine.analyser;
    expect(userGain.connections).toEqual([analyser]);
    expect((analyser as unknown as MockGainNode).connections).toEqual([bus]);
  });

  it("defaults to the context's speakers", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    expect(ctx.gains[2]!.connections).toEqual([ctx.destination]);
  });
});

describe("play({ at })", () => {
  it("starts the source on the context time given", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    ctx.currentTime = 1;
    await engine.play({ at: 1.5 });
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startWhen).toBe(1.5);
    expect(src.startOffset).toBe(0);
    expect(engine.state).toBe("playing");
  });

  it("ramps the fade up from silence at the start time, not before", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    ctx.currentTime = 1;
    await engine.play({ at: 2 });
    const fade = ctx.gains[1]!.gain;
    expect(fade.valueAt(2)).toBe(0);
    expect(fade.valueAt(2.5)).toBeCloseTo(1, 6);
  });

  it("a start time that already passed starts now, from where it would have reached", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    ctx.currentTime = 3;
    await engine.play({ at: 2.25 });
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startWhen).toBe(3);
    expect(src.startOffset).toBeCloseTo(0.75, 6);
  });

  it("keeps the start time when play() is called while the track is still loading", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    ctx.currentTime = 1;
    engine.setQueue([{ src: "/a.flac" }]);
    await engine.play({ at: 1.5 });
    for (let i = 0; i < 4; i++) await flush();
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startWhen).toBe(1.5);
  });

  it("does not carry a start time over into a later skip", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    ctx.currentTime = 1;
    engine.setQueue([{ src: "/a.flac" }, { src: "/b.flac" }]);
    await engine.play({ at: 1.5 });
    for (let i = 0; i < 4; i++) await flush();
    ctx.currentTime = 3;
    engine.next();
    for (let i = 0; i < 4; i++) await flush();
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startWhen).toBeGreaterThanOrEqual(3);
  });

  it("reads the starting position until the start time arrives", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    engine.seek(1);
    ctx.currentTime = 5;
    await engine.play({ at: 7 });
    ctx.currentTime = 6;
    expect(engine.currentTime).toBe(1);
    ctx.currentTime = 7.5;
    expect(engine.currentTime).toBeCloseTo(1.5, 6);
  });

  it("a seek before the start time keeps the start time", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    ctx.currentTime = 1;
    await engine.play({ at: 3 });
    engine.seek(2);
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startWhen).toBe(3);
    expect(src.startOffset).toBe(2);
  });

  it("under repeat-one, a very late start wraps around the loop instead of clamping", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    engine.setRepeat("one");
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    ctx.currentTime = 10;
    await engine.play({ at: 0.5 });
    const src = ctx.sources[ctx.sources.length - 1]!;
    expect(src.startOffset).toBeCloseTo(9.5 % 4, 6);
  });
});

describe("destination without a context", () => {
  it("uses the destination's own context", () => {
    const ctx = new MockAudioContext();
    const bus = new MockGainNode();
    (bus as unknown as { context: unknown }).context = ctx;
    const engine = new EkoWebEngine({ destination: bus as unknown as AudioNode });
    expect(engine.context).toBe(ctx);
  });
});
