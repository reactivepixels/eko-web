import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { trackEndTime } from "../src/engine/scheduling";
import {
  MockAudioContext,
  MockMediaElement,
  makeToneBuffer,
  stubFetch,
  sourceGains,
} from "./mock-audio";

/** Flush pending microtasks (lets the async armNext decode + schedule complete). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

function setup(trackCount: number) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5); // 0.5-second tracks
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
  const tracks = Array.from({ length: trackCount }, (_, i) => ({
    id: String(i),
    src: `/t${i}.flac`,
  }));
  return { ctx, engine, tracks };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("gapless", () => {
  it("schedules the next track to start exactly when the current ends, each with its own gain", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(2);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush(); // arm + schedule track B

    expect(ctx.sources.length).toBe(2); // current + armed
    const endTime = trackEndTime(0, 0.5, 0); // started at ctx 0, 0.5s track → ends at 0.5
    expect(ctx.sources[1]!.startWhen).toBeCloseTo(endTime, 6);

    // Each source carries its own normalization gain, created when connect() runs, so
    // there is no longer a single shared node whose value has to jump at the boundary:
    // the current and armed tracks are simply two distinct gain nodes with nothing
    // scheduled on either of them.
    const gains = sourceGains(ctx);
    expect(gains.length).toBe(2);
    expect(gains[0]).not.toBe(gains[1]);
    expect(gains[0]!.gain.scheduled).toEqual([]);
    expect(gains[1]!.gain.scheduled).toEqual([]);
  });

  it("promotes the armed track on the boundary and emits trackchange", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(2);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const changed = vi.fn();
    engine.on("trackchange", changed);
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded(); // track A ends → seamless promote to B
    expect(engine.currentIndex).toBe(1);
    expect(changed).toHaveBeenCalledWith({ index: 1, track: tracks[1], transition: "gapless" });
    expect(engine.state).not.toBe("ended");
  });

  it("ends the queue after the final track (nothing to promote)", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(1);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const ended = vi.fn();
    engine.on("ended", ended);
    await engine.play();
    await flush();
    ctx.sources[0]!.fireEnded();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(engine.state).toBe("ended");
  });

  it("pause stops the armed next source", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(2);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(2);
    engine.pause();
    expect(ctx.sources[1]!.stopped).toBe(true);
  });

  it("a cleared armed source firing a late ended event does not advance the track", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(2);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const ended = vi.fn();
    const changed = vi.fn();
    engine.on("ended", ended);
    engine.on("trackchange", changed);
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(2);

    engine.pause(); // stops and disposes the armed source
    expect(ctx.sources[1]!.stopped).toBe(true);

    // The browser can still fire the node's natural 'ended' event after it was already
    // stopped and disposed. That must not be mistaken for the track reaching its end.
    ctx.sources[1]!.fireEnded();

    expect(ended).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(engine.currentIndex).toBe(0);
    expect(engine.state).toBe("paused");
  });

  it("chains A → B → C", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3);
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush(); // arm B
    ctx.sources[0]!.fireEnded(); // promote B
    await flush(); // arm C
    expect(engine.currentIndex).toBe(1);
    expect(ctx.sources.length).toBe(3);
    ctx.sources[1]!.fireEnded(); // B ends → promote C
    expect(engine.currentIndex).toBe(2);
  });

  it("never arms a next track when the current source cannot be sample-accurate", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const tracks = [
      { id: "0", src: "/t0.flac", source: "element" as const },
      { id: "1", src: "/t1.flac", source: "element" as const },
    ];

    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    } as unknown as typeof Audio;
    // The element strategy warns once per instance when it cannot measure loudness;
    // that is unrelated to this test, so keep it out of the test output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ready = whenReady(engine);
      engine.setQueue(tracks);
      await ready;
      await engine.play();
      await flush(); // would-be arm attempt for track B

      // A streaming source can never be scheduled to a sample, so armNext must bail
      // before loading (let alone starting) the next track.
      expect(ctx.sources.length).toBe(0); // no buffer source ever created
      expect(ctx.mediaSources.length).toBe(1); // only the current track, never track B
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });

  it("loads but discards an incoming track that cannot be sample-accurate, even when the current one can", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    const tracks = [
      { id: "0", src: "/t0.flac" }, // default: buffer, gapless-capable
      { id: "1", src: "/t1.flac", source: "element" as const }, // forced to element
    ];

    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ready = whenReady(engine);
      engine.setQueue(tracks);
      await ready;
      await engine.play();
      await flush(); // would-be arm attempt for track B

      expect(ctx.sources.length).toBe(1); // only track A's buffer source, never armed a second
      expect(ctx.mediaSources.length).toBe(1); // track B was loaded, then discarded unarmed

      // With nothing armed, track A's natural end now advances the queue with an audible
      // gap instead of an early start on an unscheduled element source, and instead of
      // stalling on track A forever.
      ctx.sources[0]!.fireEnded();
      await flush();
      await flush(); // track B (element) reloads from a standing start
      expect(engine.currentIndex).toBe(1);
      expect(engine.state).not.toBe("ended");
      expect(engine.lastTransition).toBe("gap");
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
  /**
   * Both of these hang off the same seek: play() fires an arm, seek() moves the boundary
   * while that arm is still awaiting its own load, and seek() fires a second arm of its own.
   */
  function seekDuringArm(): {
    ctx: MockAudioContext;
    engine: EkoWebEngine;
    tracks: Array<{ id: string; src: string; source: "buffer" }>;
    fetches: () => number;
  } {
    let count = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      count++;
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };

    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5, 3); // 3-second tracks
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
    // Forced to the buffer strategy so each load is exactly one fetch, with no HEAD probe
    // in between to count around.
    const tracks = [
      { id: "a", src: "/a.flac", source: "buffer" as const },
      { id: "b", src: "/b.flac", source: "buffer" as const },
    ];
    return { ctx, engine, tracks, fetches: () => count };
  }

  it("schedules the armed track against the clock a seek left behind, not the one captured before its load", async () => {
    const { ctx, engine, tracks } = seekDuringArm();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    engine.seek(1); // lands while the first arm is still awaiting its load
    await flush();

    // The seek restarted A at ctx 0.01 from offset 1, so A now ends at 2.01. An arm still
    // holding the clock it read before the load schedules B at 3 instead: a second of
    // silence on a boundary that exists to have none.
    const armed = ctx.sources[ctx.sources.length - 1]!;
    expect(armed.startWhen).toBeCloseTo(2.01, 6);
  });

  it("does not start a second load for a boundary another arm is already loading", async () => {
    const { engine, tracks, fetches } = seekDuringArm();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    engine.seek(1);
    engine.seek(2); // a scrub is many seeks, and every one of them re-arms
    await flush();

    // Track A's own load, plus exactly one for the boundary. Without the in-flight marker
    // each seek issues its own fetch and decode of the same track and throws all but one
    // away, which for a five minute FLAC is hundreds of megabytes of transient decode.
    expect(fetches()).toBe(2);
  });
});
