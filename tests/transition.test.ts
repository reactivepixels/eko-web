import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, MockMediaElement, makeToneBuffer, stubFetch } from "./mock-audio";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

/** Resolve with the next trackchange payload, so tests never guess at tick counts. */
function nextTrackChange(
  engine: EkoWebEngine,
): Promise<{ index: number; track: unknown; transition: string }> {
  return new Promise((res) => {
    const off = engine.on("trackchange", (payload) => {
      off();
      res(payload);
    });
  });
}

function setup(options = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, ...options });
  const tracks = [
    { id: "a", src: "/a.flac" },
    { id: "b", src: "/b.flac" },
  ];
  return { ctx, engine, tracks };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("transition reporting", () => {
  it("reports a gapless promotion as gapless", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const changed = vi.fn();
    engine.on("trackchange", changed);
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded();
    expect(changed).toHaveBeenCalledWith({
      index: 1,
      track: tracks[1],
      transition: "gapless",
    });
    expect(engine.lastTransition).toBe("gapless");
  });

  it("does not arm anything when the transition is gap", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1); // current only, nothing armed
  });

  it("still advances the queue with a gap, and says so", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    // Await the event rather than guessing how many ticks the reload takes.
    const changed = nextTrackChange(engine);
    ctx.sources[0]!.fireEnded();
    expect(await changed).toEqual({ index: 1, track: tracks[1], transition: "gap" });
    expect(engine.currentIndex).toBe(1);
    expect(engine.lastTransition).toBe("gap");
    expect(engine.state).not.toBe("ended");
  });

  it("refuses to arm when the source cannot be sample-accurate", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup();
    // The element strategy calls `new Audio()`, which does not exist in Node, so stand one
    // up for the duration of this test and announce metadata as soon as it is built.
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    };
    try {
      const ready = whenReady(engine);
      engine.setQueue(tracks.map((t) => ({ ...t, source: "element" as const })));
      await ready;
      await engine.play();
      await flush();
      await flush();

      // The element is playing, but nothing was armed: no buffer source was ever built.
      expect(ctx.sources.length).toBe(0);
      expect(ctx.mediaSources.length).toBe(1);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
    }
  });

  it("reports a manual skip as a gap", async () => {
    restore = stubFetch();
    const { engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;

    const changed = nextTrackChange(engine);
    engine.next();
    expect(await changed).toEqual({ index: 1, track: tracks[1], transition: "gap" });
    expect(engine.lastTransition).toBe("gap");
  });

  it("starts with no transition reported", () => {
    const { engine } = setup();
    expect(engine.lastTransition).toBeNull();
  });

  it("does not resume playback if pause() is called while a gap-advance is loading", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // Track A ends. The engine starts loading track B in the background (advanceWithGap),
    // which is asynchronous. Before that load settles, the consumer asks to pause.
    ctx.sources[0]!.fireEnded();
    engine.pause();

    await flush();
    await flush();

    // The load completed and the queue advanced, but the explicit pause during the load
    // must win: playback must not resume against the consumer's request.
    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(true);
    expect(engine.state).not.toBe("playing");
    expect(ctx.sources.length).toBe(1); // no new source was ever started
  });
});
