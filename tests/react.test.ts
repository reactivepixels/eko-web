// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { useEkoPlayer, useEkoTime, type EkoPlayer, type EkoTime } from "../src/react/index";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

/** Resolve once the engine reports the track is ready to play. */
function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

function makeEngine(): EkoWebEngine {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  return new EkoWebEngine({ context: ctx as unknown as AudioContext });
}

/** Same as {@link makeEngine}, but also hands back the mock context so a test can move
 * its clock (`ctx.currentTime = …`) to drive `useEkoTime`. */
function makeEngineWithCtx(): { ctx: MockAudioContext; engine: EkoWebEngine } {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
  return { ctx, engine };
}

/** The engine's private subscriber set, read through a soft cast: TS `private` is
 * compile-time only, and this is the most direct way to assert a mount/unmount cycle
 * leaves no dangling subscription behind. */
function subscriberCount(engine: EkoWebEngine): number {
  return (engine as unknown as { subscribers: Set<unknown> }).subscribers.size;
}

/** Mount a probe component and hand back a live reference to the hook's return value,
 * plus how many times the component has rendered and an unmount function. */
function renderPlayer(engine: EkoWebEngine) {
  const ref: { player: EkoPlayer | null; renders: number } = { player: null, renders: 0 };
  function Probe() {
    ref.player = useEkoPlayer(engine);
    ref.renders++;
    return null;
  }
  const { unmount } = render(createElement(Probe));
  return { ref: ref as { player: EkoPlayer; renders: number }, unmount };
}

/** Same shape as {@link renderPlayer}, for `useEkoTime`. */
function renderTime(engine: EkoWebEngine) {
  const ref: { time: EkoTime | null; renders: number } = { time: null, renders: 0 };
  function Probe() {
    ref.time = useEkoTime(engine);
    ref.renders++;
    return null;
  }
  const { unmount } = render(createElement(Probe));
  return { ref: ref as { time: EkoTime; renders: number }, unmount };
}

/**
 * A deterministic stand-in for the browser's frame scheduler. `requestAnimationFrame`
 * normally fires every ~16ms on its own; that would make a test either flaky (racing real
 * timers) or slow (waiting on them). This instead queues callbacks and only runs them when
 * the test calls `fireFrame()`, which mimics one real frame: every callback currently
 * pending fires once, and any of them may re-queue itself for the next `fireFrame()`, same
 * as a real `requestAnimationFrame` loop.
 */
function stubRaf() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const cancelled = new Set<number>();
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((id: number): void => {
    cancelled.add(id);
    pending.delete(id);
  }) as typeof cancelAnimationFrame;

  function fireFrame(time = 0): void {
    const due = [...pending.entries()];
    pending.clear();
    for (const [, cb] of due) cb(time);
  }

  function restore(): void {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  }

  return {
    fireFrame,
    restore,
    /** How many frames are currently queued, across every caller (hook + engine alike). */
    pendingCount: () => pending.size,
    /** Every id `cancelAnimationFrame` has been called with. */
    cancelledIds: cancelled,
    /** Total `requestAnimationFrame` calls so far, hook and engine combined. */
    callCount: () => nextId - 1,
  };
}

let restoreFetch: (() => void) | null = null;
let restoreRaf: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreRaf?.();
  restoreRaf = null;
  cleanup();
});

describe("useEkoPlayer", () => {
  it("returns the engine's current snapshot fields", () => {
    const engine = makeEngine();
    const { ref } = renderPlayer(engine);
    const snap = engine.getSnapshot();

    expect(ref.player.state).toBe(snap.state);
    expect(ref.player.paused).toBe(snap.paused);
    expect(ref.player.index).toBe(snap.index);
    expect(ref.player.queueLength).toBe(snap.queueLength);
    expect(ref.player.track).toBe(snap.track);
    expect(ref.player.shuffle).toBe(snap.shuffle);
    expect(ref.player.repeat).toBe(snap.repeat);
  });

  it("re-renders with the engine's new values once something changes", async () => {
    restoreFetch = stubFetch();
    const engine = makeEngine();
    const { ref } = renderPlayer(engine);
    const rendersBefore = ref.renders;

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });

    expect(ref.renders).toBeGreaterThan(rendersBefore);
    expect(ref.player.queueLength).toBe(1);
    expect(ref.player.index).toBe(0);
    expect(ref.player.track?.id).toBe("a");
  });

  it("returns a referentially stable object across an unrelated re-render", () => {
    const engine = makeEngine();
    const seen: EkoPlayer[] = [];
    let forceRerender: (() => void) | null = null;
    function Probe() {
      const [, setTick] = useState(0);
      forceRerender = () => setTick((t) => t + 1);
      seen.push(useEkoPlayer(engine));
      return null;
    }
    render(createElement(Probe));
    expect(seen.length).toBe(1);

    act(() => {
      forceRerender!();
    });

    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it("keeps every transport callback's identity stable across an unrelated re-render", () => {
    const engine = makeEngine();
    const seen: EkoPlayer[] = [];
    let forceRerender: (() => void) | null = null;
    function Probe() {
      const [, setTick] = useState(0);
      forceRerender = () => setTick((t) => t + 1);
      seen.push(useEkoPlayer(engine));
      return null;
    }
    render(createElement(Probe));
    act(() => {
      forceRerender!();
    });

    const first = seen[0]!;
    const second = seen[1]!;
    expect(second.play).toBe(first.play);
    expect(second.pause).toBe(first.pause);
    expect(second.next).toBe(first.next);
    expect(second.previous).toBe(first.previous);
    expect(second.skipTo).toBe(first.skipTo);
    expect(second.seek).toBe(first.seek);
    expect(second.setShuffle).toBe(first.setShuffle);
    expect(second.setRepeat).toBe(first.setRepeat);
    expect(second.setVolume).toBe(first.setVolume);
    expect(second.setMuted).toBe(first.setMuted);
  });

  it("unmounting unsubscribes from the engine", () => {
    const engine = makeEngine();
    expect(subscriberCount(engine)).toBe(0);

    const { unmount } = renderPlayer(engine);
    expect(subscriberCount(engine)).toBe(1);

    unmount();
    expect(subscriberCount(engine)).toBe(0);
  });

  describe("transport callbacks", () => {
    it("play() calls engine.play()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "play").mockResolvedValue(undefined);
      const { ref } = renderPlayer(engine);

      ref.player.play();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
    });

    it("pause() calls engine.pause()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "pause").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.pause();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
    });

    it("next() calls engine.next()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "next").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.next();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
    });

    it("previous() calls engine.previous()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "previous").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.previous();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
    });

    it("skipTo(index) calls engine.skipTo(index)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "skipTo").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.skipTo(3);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(3);
    });

    it("seek(time) calls engine.seek(time)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "seek").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.seek(12.5);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(12.5);
    });

    it("setShuffle(on) calls engine.setShuffle(on)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setShuffle").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.setShuffle(true);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(true);
    });

    it("setRepeat(mode) calls engine.setRepeat(mode)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setRepeat").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.setRepeat("one");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("one");
    });

    it("setVolume(v) calls engine.setVolume(v)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setVolume").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.setVolume(0.4);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(0.4);
    });

    it("setMuted(muted) calls engine.setMuted(muted)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setMuted").mockImplementation(() => {});
      const { ref } = renderPlayer(engine);

      ref.player.setMuted(true);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(true);
    });
  });
});

describe("useEkoTime", () => {
  it("returns the engine's currentTime and duration", () => {
    const engine = makeEngine();
    const { ref } = renderTime(engine);

    expect(ref.time).toEqual({ currentTime: engine.currentTime, duration: engine.duration });
  });

  it("does not schedule a frame while the engine is paused", () => {
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const engine = makeEngine();

    renderTime(engine);

    expect(raf.callCount()).toBe(0);
  });

  it("starts ticking immediately when mounted while the engine is already playing", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { engine } = makeEngineWithCtx();

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });

    // play() already scheduled the engine's own, separate frame; note the count before
    // mounting so the assertion below isolates the one call the hook's own on-mount sync
    // makes, without depending on real-timer timing.
    const callsBeforeMount = raf.callCount();

    renderTime(engine);

    expect(raf.callCount()).toBe(callsBeforeMount + 1);
  });

  it("ticks currentTime forward on successive animation frames while playing", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { ref } = renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });

    // The engine's own internal RAF loop (unrelated to this hook) also schedules a frame
    // once playback starts, so two frames are pending: the hook's, and the engine's.
    expect(raf.pendingCount()).toBe(2);

    ctx.currentTime = 0.2;
    act(() => {
      raf.fireFrame();
    });
    expect(ref.time.currentTime).toBeCloseTo(0.2, 3);

    ctx.currentTime = 0.35;
    act(() => {
      raf.fireFrame();
    });
    expect(ref.time.currentTime).toBeCloseTo(0.35, 3);
  });

  it("does not schedule a second frame for a discrete change that isn't a pause", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { engine } = makeEngineWithCtx();
    renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });
    expect(raf.pendingCount()).toBe(2);

    // A volume change publishes a new snapshot (so this hook's `sync` runs again) without
    // touching `paused`. A loop already scheduled must not be scheduled a second time.
    act(() => {
      engine.setVolume(0.5);
    });

    expect(raf.pendingCount()).toBe(2);
  });

  it("stops scheduling frames and cancels the pending one when the engine pauses", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { engine } = makeEngineWithCtx();
    renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });
    expect(raf.pendingCount()).toBe(2);

    act(() => {
      engine.pause();
    });

    // Both the hook's own pending frame and the engine's separate internal one stop.
    expect(raf.pendingCount()).toBe(0);
    // The hook's frame is the first one scheduled: play() notifies subscribers (this
    // hook among them) before it starts the engine's own, separate RAF loop.
    expect(raf.cancelledIds.has(1)).toBe(true);
  });

  it("resumes ticking after a pause/resume cycle", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { ref } = renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });
    act(() => {
      engine.pause();
    });
    expect(raf.pendingCount()).toBe(0);

    await act(async () => {
      await engine.play();
    });

    // A frame must be pending again, or the loop died for good after the first pause.
    expect(raf.pendingCount()).toBe(2);

    ctx.currentTime += 0.4;
    act(() => {
      raf.fireFrame();
    });

    expect(ref.time.currentTime).toBeCloseTo(engine.currentTime, 3);
  });

  it("cancels the pending frame on unmount", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { engine } = makeEngineWithCtx();
    const { unmount } = renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });
    expect(raf.pendingCount()).toBe(2);

    unmount();

    // Only the hook's own handle is cancelled; the engine keeps playing (and keeps its
    // own separate frame pending) because unmounting a consumer must not touch the engine.
    expect(raf.cancelledIds.has(1)).toBe(true);
    expect(raf.pendingCount()).toBe(1);
  });

  it("unmounting unsubscribes from the engine", () => {
    const engine = makeEngine();
    expect(subscriberCount(engine)).toBe(0);

    const { unmount } = renderTime(engine);
    expect(subscriberCount(engine)).toBe(1);

    unmount();
    expect(subscriberCount(engine)).toBe(0);
  });

  it("a time-only update re-renders the time consumer but not the player consumer", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();

    const player = renderPlayer(engine);
    const time = renderTime(engine);

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    await act(async () => {
      await engine.play();
    });

    const playerRendersAfterPlay = player.ref.renders;
    const timeRendersAfterPlay = time.ref.renders;

    ctx.currentTime = 0.25;
    act(() => {
      raf.fireFrame();
    });

    expect(time.ref.renders).toBeGreaterThan(timeRendersAfterPlay);
    expect(player.ref.renders).toBe(playerRendersAfterPlay);
  });
});
