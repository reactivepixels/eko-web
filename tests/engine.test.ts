import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { EkoError } from "../src/engine/errors";
import { measureLoudnessLufs, samplePeak, computeNormalizationGain } from "../src/engine/loudness";
import {
  MockAudioContext,
  MockMediaElement,
  makeToneBuffer,
  stubFetch,
  sourceGains,
} from "./mock-audio";

function makeEngine(buffer = makeToneBuffer(0.5), opts = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = buffer;
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, ...opts });
  return { ctx, engine };
}

/** Resolve once the engine reports the track is ready to play. */
function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("EkoWebEngine load", () => {
  it("decodes a queued track and reaches the ready state", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine();
    const loaded = vi.fn();
    engine.on("loadedmetadata", loaded);
    const ready = whenReady(engine);
    engine.setQueue([{ id: "1", src: "/a.flac" }]);
    await ready;
    expect(engine.state).toBe("ready");
    expect(engine.duration).toBeCloseTo(0.5, 3);
    expect(loaded).toHaveBeenCalledWith({ index: 0, duration: engine.duration });
  });

  it("emits an error and enters the error state when the fetch fails", async () => {
    restoreFetch = stubFetch(false, 404);
    const { engine } = makeEngine();
    const error = await new Promise<EkoError>((res) => {
      engine.on("error", ({ error }) => res(error));
      engine.setQueue([{ src: "/missing.flac" }]);
    });
    expect(error).toBeInstanceOf(EkoError);
    expect(error.code).toBe("fetch_failed");
    expect(engine.state).toBe("error");
  });
});

describe("EkoWebEngine normalization", () => {
  it("applies the clamp-to-peak normalization gain to the source's own gain on play", async () => {
    restoreFetch = stubFetch();
    const buffer = makeToneBuffer(0.5);
    const { ctx, engine } = makeEngine(buffer, { targetLufs: -16 });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    // Compute the expected gain from the same buffer the engine saw.
    const channels = [buffer.getChannelData(0)];
    const expected = computeNormalizationGain(
      measureLoudnessLufs(channels, buffer.sampleRate),
      -16,
      samplePeak(channels),
    );
    await engine.play();
    // The graph's own three gains (input, fadeGain, userGain) sit at index 0-2; the
    // source's normalization gain lands after them, created when connect() runs.
    expect(sourceGains(ctx)[0]!.gain.value).toBeCloseTo(expected, 6);
    expect(sourceGains(ctx)[0]!.gain.value * samplePeak(channels)).toBeLessThanOrEqual(1.0001);
  });

  it("with normalize:false the source's own gain stays at unity", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine(makeToneBuffer(0.5), { normalize: false });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();
    expect(sourceGains(ctx)[0]!.gain.value).toBeCloseTo(1, 6);
  });
});

describe("EkoWebEngine transport", () => {
  it("play → playing, pause → paused with the position preserved", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;

    await engine.play();
    expect(engine.state).toBe("playing");
    expect(engine.paused).toBe(false);

    // Advance the mock clock by 0.2s, then pause.
    ctx.currentTime = 0.2;
    engine.pause();
    expect(engine.state).toBe("paused");
    expect(engine.paused).toBe(true);
    expect(engine.currentTime).toBeCloseTo(0.2, 3);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it("setVolume and setMuted drive the userGain node", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play(); // build the graph
    const userGain = ctx.gains[2]!; // input, fade, user

    engine.setVolume(0.5);
    expect(userGain.gain.value).toBeCloseTo(0.5, 6);
    engine.setMuted(true);
    expect(userGain.gain.value).toBe(0);
    engine.setMuted(false);
    expect(userGain.gain.value).toBeCloseTo(0.5, 6);
  });

  it("emits 'ended' when the source finishes naturally", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();
    const ended = vi.fn();
    engine.on("ended", ended);
    ctx.sources[0]!.fireEnded();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(engine.state).toBe("ended");
  });
});

describe("EkoWebEngine error codes", () => {
  it("reports a failed fetch as fetch_failed", async () => {
    restoreFetch = stubFetch(false, 404);
    const { engine } = makeEngine();
    const error = await new Promise<EkoError>((res) => {
      engine.on("error", ({ error }) => res(error));
      engine.setQueue([{ src: "/missing.flac" }]);
    });
    expect(error).toBeInstanceOf(EkoError);
    expect(error.code).toBe("fetch_failed");
    expect(error.recoverable).toBe(false);
    expect(engine.state).toBe("error");
  });

  it("reports a rejected decode as decode_failed and keeps the cause", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    const boom = new Error("bad bytes");
    ctx.decodeAudioData = async () => {
      throw boom;
    };
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const error = await new Promise<EkoError>((res) => {
      engine.on("error", ({ error }) => res(error));
      engine.setQueue([{ src: "/a.flac" }]);
    });
    expect(error.code).toBe("decode_failed");
    expect(error.cause).toBe(boom);
  });

  it("a manual next() whose load fails leaves getSnapshot() reporting the track still playing, consistently", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    // Only the second decode (track b, loaded by next()) fails; the first (track a, the
    // initial load) succeeds normally.
    let decodeCount = 0;
    const boom = new Error("bad bytes");
    ctx.decodeAudioData = async () => {
      decodeCount++;
      if (decodeCount === 2) throw boom;
      if (!ctx.nextBuffer) throw new Error("mock: no nextBuffer set");
      return ctx.nextBuffer;
    };
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await ready;

    const errored = new Promise<EkoError>((res) => {
      engine.on("error", ({ error }) => res(error));
    });
    engine.next();
    const error = await errored;
    // The "error" event fires from inside loadIndex's own catch block, before skipTo's
    // continuation (which does the rollback) has resumed from its await. Let that
    // continuation actually run before asserting on its result.
    await new Promise((r) => setTimeout(r, 0));

    expect(error.cause).toBe(boom);
    // next() moved the queue to track b eagerly, before the failed load even started;
    // the failure must roll that back, or index and track disagree about what is playing.
    const snapshot = engine.getSnapshot();
    expect(snapshot.index).toBe(0);
    expect(snapshot.track?.id).toBe("a");
    expect(engine.currentIndex).toBe(0);
  });

  it('next() under repeat "one" advances to the following track instead of restarting the current one', async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine();
    engine.setRepeat("one");
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await ready;
    expect(engine.currentIndex).toBe(0);

    const readyB = whenReady(engine);
    engine.next();
    await readyB;
    expect(engine.currentIndex).toBe(1);
    expect(engine.getSnapshot().track?.id).toBe("b");
  });

  it("emits autoplay_blocked when resume rejects, without rejecting play()", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;

    ctx.state = "suspended";
    ctx.resume = async () => {
      throw new Error("no user gesture");
    };
    const errors: EkoError[] = [];
    engine.on("error", ({ error }) => errors.push(error));

    await expect(engine.play()).resolves.toBeUndefined();
    expect(errors.map((e) => e.code)).toContain("autoplay_blocked");
    expect(engine.paused).toBe(true);
  });

  it("emits a recoverable prefetch_failed when the next track cannot be armed", async () => {
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });

    // Track A's load takes two fetches (the auto-select HEAD probe, then the real GET),
    // and both succeed. Every fetch after that fails, which fails both the HEAD probe and
    // the GET while arming track B.
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: calls <= 2,
        status: calls <= 2 ? 200 : 500,
        headers: { get: (): string | null => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };

    const errors: EkoError[] = [];
    engine.on("error", ({ error }) => errors.push(error));
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }, { src: "/b.flac" }]);
    await ready;
    await engine.play();
    await new Promise((r) => setTimeout(r, 0));

    const prefetch = errors.find((e) => e.code === "prefetch_failed");
    expect(prefetch).toBeDefined();
    expect(prefetch!.recoverable).toBe(true);
    // Playback of the current track is unaffected.
    expect(engine.paused).toBe(false);
  });
});

describe("EkoWebEngine destroy()", () => {
  it("throws a coded destroyed error from every mutating method afterward, and never rebuilds the graph", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();
    const gainsBefore = ctx.gains.length;

    engine.destroy();

    expect(() => engine.setQueue([{ src: "/b.flac" }])).toThrow(
      expect.objectContaining({ code: "destroyed" }),
    );
    expect(() => engine.pause()).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.seek(0.1)).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.next()).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.previous()).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.setVolume(0.5)).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.setMuted(true)).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.setInserts([])).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.context).toThrow(expect.objectContaining({ code: "destroyed" }));
    expect(() => engine.analyser).toThrow(expect.objectContaining({ code: "destroyed" }));
    await expect(engine.play()).rejects.toMatchObject({ code: "destroyed" });

    // None of the above resurrected the graph: no fresh input/fadeGain/userGain triple.
    expect(ctx.gains.length).toBe(gainsBefore);
  });

  it("is idempotent: a second destroy() does not throw", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine();
    engine.destroy();
    expect(() => engine.destroy()).not.toThrow();
  });

  it("publishes one final, accurate snapshot and stops notifying subscribers afterward", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();
    expect(engine.getSnapshot().state).toBe("playing");

    let notifications = 0;
    engine.subscribe(() => {
      notifications += 1;
    });
    engine.destroy();

    const finalSnapshot = engine.getSnapshot();
    expect(finalSnapshot.state).toBe("idle");
    expect(finalSnapshot.paused).toBe(true);
    expect(finalSnapshot.track).toBeNull();
    expect(finalSnapshot.index).toBe(-1);
    expect(notifications).toBe(1); // the final publish reached the subscriber exactly once
  });
});

describe("EkoWebEngine element start failure", () => {
  it("surfaces a coded autoplay_blocked error and corrects paused/state when the browser silently blocks play()", async () => {
    const ctx = new MockAudioContext();
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });

    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    let element!: MockMediaElement;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ready = whenReady(engine);
      engine.setQueue([{ src: "/long.flac", source: "element" }]);
      await ready;

      // The browser silently blocks this without the element's own user gesture (the
      // ordinary case on iOS Safari); play() itself never rejects for it.
      element.play = () => Promise.reject(new Error("NotAllowedError"));

      const errors: EkoError[] = [];
      engine.on("error", ({ error }) => errors.push(error));
      await expect(engine.play()).resolves.toBeUndefined();

      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      const blocked = errors.find((e) => e.code === "autoplay_blocked");
      expect(blocked).toBeDefined();
      expect(blocked!.recoverable).toBe(false);
      // The engine corrects the record instead of reporting "playing" with silence.
      expect(engine.paused).toBe(true);
      expect(engine.state).not.toBe("playing");
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});

describe("EkoWebEngine config", () => {
  it("reports every resolved option, defaults included, not just a partial set", () => {
    const { engine } = makeEngine(undefined, { transition: "gap" });
    expect(engine.config).toEqual({
      normalize: true,
      targetLufs: -16,
      transition: "gap",
      crossfadeSeconds: 3,
      fadeSeconds: 0.01,
      source: "auto",
      bufferMaxBytes: 50 * 1024 * 1024,
    });
  });

  it("reflects a fully custom set of options, not just the defaults", () => {
    const { engine } = makeEngine(undefined, {
      normalize: false,
      targetLufs: -14,
      transition: "gap",
      crossfadeSeconds: 5,
      fadeSeconds: 0.05,
      source: "element",
      bufferMaxBytes: 1024,
    });
    expect(engine.config).toEqual({
      normalize: false,
      targetLufs: -14,
      transition: "gap",
      crossfadeSeconds: 5,
      fadeSeconds: 0.05,
      source: "element",
      bufferMaxBytes: 1024,
    });
  });
});

describe("EkoWebEngine shuffle and repeat options", () => {
  it("accepts them at construction", () => {
    const ctx = new MockAudioContext();
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      shuffle: true,
      repeat: "all",
    });
    expect(engine.shuffle).toBe(true);
    expect(engine.repeat).toBe("all");
  });
});
