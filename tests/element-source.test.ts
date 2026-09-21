import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ElementSourceStrategy, METADATA_TIMEOUT_MS } from "../src/engine/sources/element-source";
import { MockAudioContext, MockMediaElement, MockGainNode } from "./mock-audio";

function setup() {
  const ctx = new MockAudioContext();
  const element = new MockMediaElement();
  const strategy = new ElementSourceStrategy(() => element as unknown as HTMLAudioElement);
  return { ctx, element, strategy };
}

/** Load resolves only once metadata arrives, so announce it on the next tick. */
function loadWithMetadata(
  strategy: ElementSourceStrategy,
  ctx: MockAudioContext,
  element: MockMediaElement,
  track: { src: string; gainDb?: number },
  duration = 120,
  options = { normalize: true, targetLufs: -16 },
) {
  const promise = strategy.load(track, ctx as unknown as AudioContext, options);
  setTimeout(() => element.fireLoadedMetadata(duration), 0);
  return promise;
}

describe("ElementSourceStrategy", () => {
  // Most tracks here load with normalize:true and no gainDb, which now warns on every
  // fresh strategy (that is the point of the per-instance fix). Spy on console.warn for
  // the whole suite so that behaviour is covered without leaving stderr noisy; individual
  // tests that care about the warning assert against this same spy.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("declares itself not gapless-capable", () => {
    const { strategy } = setup();
    expect(strategy.kind).toBe("element");
    expect(strategy.canGapless).toBe(false);
  });

  it("waits for metadata and reports the element duration", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" }, 3600);
    expect(element.src).toBe("/long.flac");
    expect(loaded.duration).toBeCloseTo(3600, 6);
    expect(loaded.canGapless).toBe(false);
  });

  it("runs at unity gain when the track carries no gainDb, because there is nothing to measure", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    expect(loaded.normGain).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("gainDb");
  });

  it("warns once per strategy instance, not once per process", async () => {
    const { ctx, element, strategy } = setup();
    await loadWithMetadata(strategy, ctx, element, { src: "/one.flac" });
    // A second, independent strategy (a second player, or a fresh instance after an SPA
    // navigation) must still get the warning: it is not a one-time-per-process flag.
    const other = setup();
    await loadWithMetadata(other.strategy, other.ctx, other.element, { src: "/two.flac" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("uses a track's gainDb when it has one", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, {
      src: "/long.flac",
      gainDb: -6,
    });
    expect(loaded.normGain).toBeCloseTo(0.5012, 3);
  });

  it("seeks the element and plays on start, and pauses on stop", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    loaded.connect(new MockGainNode() as unknown as AudioNode);

    loaded.start(0, 42);
    expect(element.currentTime).toBeCloseTo(42, 6);
    expect(element.paused).toBe(false);

    loaded.stop();
    expect(element.paused).toBe(true);
  });

  it("restarts on a second start() call with a different offset, as pause/play/seek require", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    loaded.connect(new MockGainNode() as unknown as AudioNode);

    loaded.start(0, 10);
    expect(element.currentTime).toBeCloseTo(10, 6);
    expect(element.paused).toBe(false);

    loaded.stop();
    expect(element.paused).toBe(true);

    loaded.start(0, 55);
    expect(element.currentTime).toBeCloseTo(55, 6);
    expect(element.paused).toBe(false);
  });

  it("reports the element's natural end", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    let ended = 0;
    loaded.onEnded(() => {
      ended += 1;
    });
    element.fireEnded();
    expect(ended).toBe(1);
  });

  it("rejects with a coded unsupported error when the element cannot load", async () => {
    const { ctx, element, strategy } = setup();
    const promise = strategy.load({ src: "/bad.xyz" }, ctx as unknown as AudioContext, {
      normalize: false,
      targetLufs: -16,
    });
    setTimeout(() => element.fireError(), 0);
    await expect(promise).rejects.toMatchObject({ code: "unsupported" });
  });

  it("releases the element on a failed load, pausing it and clearing src", async () => {
    const { ctx, element, strategy } = setup();
    const pauseSpy = vi.spyOn(element, "pause");
    const promise = strategy.load({ src: "/bad.xyz" }, ctx as unknown as AudioContext, {
      normalize: false,
      targetLufs: -16,
    });
    setTimeout(() => element.fireError(), 0);
    await expect(promise).rejects.toMatchObject({ code: "unsupported" });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(element.src).toBe("");
  });

  it("rejects with a coded fetch_failed error when metadata never arrives", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, element, strategy } = setup();
      const pauseSpy = vi.spyOn(element, "pause");
      const promise = strategy.load({ src: "/stalled.flac" }, ctx as unknown as AudioContext, {
        normalize: false,
        targetLufs: -16,
      });
      const assertion = expect(promise).rejects.toMatchObject({ code: "fetch_failed" });
      await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS);
      await assertion;
      // A stalled connection is still a failed load: the element should be released the
      // same way any other failed load is.
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(element.src).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports bufferedEnd from the element's own live buffered range, honestly short of duration", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" }, 3600);
    // Nothing downloaded yet, even though metadata (and so duration) already arrived.
    expect(loaded.bufferedEnd).toBe(0);

    // The browser reports more has downloaded; bufferedEnd must reflect that live, not a
    // standing claim that the whole 3600s track is already available.
    element.bufferedEnd = 42;
    expect(loaded.bufferedEnd).toBeCloseTo(42, 6);
    expect(loaded.bufferedEnd).toBeLessThan(loaded.duration);
  });

  it("throws a coded destroyed error on start() after dispose(), instead of playing silently", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    loaded.connect(new MockGainNode() as unknown as AudioNode);
    loaded.start(0, 0);
    const gain = loaded.gain as unknown as MockGainNode;

    loaded.dispose();

    expect(() => loaded.start(0, 10)).toThrow(expect.objectContaining({ code: "destroyed" }));
    // Nothing silently resumed playback on the (now `src=""`) element either.
    expect(element.paused).toBe(true);
    // dispose() releases the source's own gain too, not just the persistent
    // MediaElementAudioSourceNode, or it stays connected to the graph for good.
    expect(gain.connections).toEqual([]);
  });

  it("reports an async start() failure through onStartError when play() rejects", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    loaded.connect(new MockGainNode() as unknown as AudioNode);

    const boom = new Error("NotAllowedError");
    element.play = (): Promise<void> => Promise.reject(boom);

    const errors: unknown[] = [];
    loaded.onStartError((error) => errors.push(error));
    loaded.start(0, 0);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toEqual([boom]);
  });

  it("does not report a start error once the source has been disposed before play() rejects", async () => {
    const { ctx, element, strategy } = setup();
    const loaded = await loadWithMetadata(strategy, ctx, element, { src: "/long.flac" });
    loaded.connect(new MockGainNode() as unknown as AudioNode);

    let rejectPlay!: (error: unknown) => void;
    element.play = (): Promise<void> =>
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      });

    const errors: unknown[] = [];
    loaded.onStartError((error) => errors.push(error));
    loaded.start(0, 0);
    // The engine moved on (a pause, seek or skip) and disposed this source before the
    // browser ever got back to us about the play() call it made.
    loaded.dispose();
    rejectPlay(new Error("too late to matter"));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toEqual([]);
  });
});
