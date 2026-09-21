import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { trackEndTime } from "../src/engine/scheduling";
import { MockAudioContext, MockMediaElement, makeToneBuffer, stubFetch } from "./mock-audio";

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
  it("schedules the next track to start exactly when the current ends", async () => {
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
    // The shared normalization gain is scheduled to jump at the boundary.
    const jumped = ctx.gains[0]!.gain.scheduled.some((s) => Math.abs(s.time - endTime) < 1e-6);
    expect(jumped).toBe(true);
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
});
