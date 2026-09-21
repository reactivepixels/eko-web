import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { EkoError } from "../src/engine/errors";
import { measureLoudnessLufs, samplePeak, computeNormalizationGain } from "../src/engine/loudness";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

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

describe("EkoWebEngine — load", () => {
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

describe("EkoWebEngine — normalization", () => {
  it("applies the clamp-to-peak normalization gain to rgGain on play", async () => {
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
    // gains[0] is rgGain (created first in ensureGraph).
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(expected, 6);
    expect(ctx.gains[0]!.gain.value * samplePeak(channels)).toBeLessThanOrEqual(1.0001);
  });

  it("with normalize:false the rgGain stays at unity", async () => {
    restoreFetch = stubFetch();
    const { ctx, engine } = makeEngine(makeToneBuffer(0.5), { normalize: false });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(1, 6);
  });
});

describe("EkoWebEngine — transport", () => {
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
    const userGain = ctx.gains[2]!; // rg, fade, user

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
