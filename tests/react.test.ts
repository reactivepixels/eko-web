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

/** The engine's private `timeupdate` listener set, read the same way {@link
 * subscriberCount} reads the discrete-state one: `useEkoTime` no longer runs a loop of
 * its own, so the only thing left to leak on unmount is this event subscription. */
function timeupdateListenerCount(engine: EkoWebEngine): number {
  const emitter = (engine as unknown as { emitter: { listeners: Map<string, Set<unknown>> } })
    .emitter;
  return emitter.listeners.get("timeupdate")?.size ?? 0;
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
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;

  // Still stubbed (not just a no-op) so that the engine's own `stopRaf()` genuinely
  // removes its pending frame from this queue on pause; `pendingCount()` below only stays
  // accurate because cancelling actually clears the map.
  globalThis.cancelAnimationFrame = ((id: number): void => {
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
    /** How many frames are currently queued (the engine's own internal loop; `useEkoTime`
     * runs none of its own). */
    pendingCount: () => pending.size,
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

  it("reflects the engine's position when mounted after a load, before any playback", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngineWithCtx();

    const ready = whenReady(engine);
    await act(async () => {
      engine.setQueue([{ id: "a", src: "/a.flac" }]);
      await ready;
    });
    // A seek while paused moves `currentTime` and emits `timeupdate`, but nothing is
    // mounted yet to hear it: the hook must pick this up from its own initial read, since
    // this is the "no event has fired yet" case, not from having observed that event.
    engine.seek(0.15);

    const { ref } = renderTime(engine);

    expect(ref.time.currentTime).toBeCloseTo(0.15, 3);
    expect(ref.time.duration).toBeCloseTo(0.5, 3); // makeToneBuffer(0.5)
  });

  it("updates on successive timeupdate events while playing", async () => {
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

    // Only the engine's own per-frame loop is scheduled; useEkoTime runs no loop of its
    // own and relies entirely on the `timeupdate` event that loop emits.
    expect(raf.pendingCount()).toBe(1);

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

  it("does not update after the engine pauses", async () => {
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

    ctx.currentTime = 0.2;
    act(() => {
      raf.fireFrame();
    });
    expect(ref.time.currentTime).toBeCloseTo(0.2, 3);

    act(() => {
      engine.pause();
    });
    expect(raf.pendingCount()).toBe(0);

    // The clock keeps moving, as it would in a real browser, but nothing is left to fire:
    // pausing stops the engine's loop, so no further `timeupdate` reaches the hook.
    ctx.currentTime = 9;
    act(() => {
      raf.fireFrame();
    });
    expect(ref.time.currentTime).toBeCloseTo(0.2, 3);
  });

  it("unmount unsubscribes from the engine's timeupdate event", () => {
    const engine = makeEngine();
    expect(timeupdateListenerCount(engine)).toBe(0);

    const { unmount } = renderTime(engine);
    expect(timeupdateListenerCount(engine)).toBe(1);

    unmount();
    expect(timeupdateListenerCount(engine)).toBe(0);
  });

  it("a volume change while playing does not disturb time updates or add a duplicate subscription", async () => {
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
    expect(timeupdateListenerCount(engine)).toBe(1);

    // A volume change publishes a new discrete snapshot. useEkoTime never subscribed to
    // that channel, so this must not add a second `timeupdate` listener.
    act(() => {
      engine.setVolume(0.5);
    });
    expect(timeupdateListenerCount(engine)).toBe(1);

    ctx.currentTime = 0.3;
    act(() => {
      raf.fireFrame();
    });
    expect(ref.time.currentTime).toBeCloseTo(0.3, 3);
  });

  it("resumes updates after a pause/resume cycle", async () => {
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

    // The engine's loop must be running again, or playback resumed with no way left to
    // reach this hook.
    expect(raf.pendingCount()).toBe(1);

    ctx.currentTime += 0.4;
    act(() => {
      raf.fireFrame();
    });

    expect(ref.time.currentTime).toBeCloseTo(engine.currentTime, 3);
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
