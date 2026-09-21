import { describe, it, expect } from "vitest";
import { ElementSourceStrategy } from "../src/engine/sources/element-source";
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
});
