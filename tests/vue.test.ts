import { describe, it, expect, afterEach, vi } from "vitest";
import { effectScope, nextTick, shallowRef, type EffectScope } from "vue";
import { useEkoPlayer, useEkoTime } from "../src/vue/index";
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
 * compile-time only, and this is the most direct way to assert a setup/teardown cycle
 * leaves no dangling subscription behind. */
function subscriberCount(engine: EkoWebEngine): number {
  return (engine as unknown as { subscribers: Set<unknown> }).subscribers.size;
}

/** The engine's private `timeupdate` listener set, read the same way {@link
 * subscriberCount} reads the discrete-state one. */
function timeupdateListenerCount(engine: EkoWebEngine): number {
  const emitter = (engine as unknown as { emitter: { listeners: Map<string, Set<unknown>> } })
    .emitter;
  return emitter.listeners.get("timeupdate")?.size ?? 0;
}

/**
 * A deterministic stand-in for the browser's frame scheduler, identical in shape to the
 * one in `tests/react.test.ts`. Queues `requestAnimationFrame` callbacks and only runs
 * them when the test calls `fireFrame()`, mimicking one real frame.
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

/** Run `fn` inside a bare `effectScope()` (no component), returning both its result and
 * the scope, so a test can call `scope.stop()` to trigger `onScopeDispose` directly:
 * the case spec 8.2 calls out that a component-only test would not catch. */
function runInScope<T>(fn: () => T): { result: T; scope: EffectScope } {
  const scope = effectScope();
  const result = scope.run(fn) as T;
  return { result, scope };
}

let restoreFetch: (() => void) | null = null;
let restoreRaf: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreRaf?.();
  restoreRaf = null;
});

describe("useEkoPlayer", () => {
  it("returns a shallowRef whose value is the engine's current snapshot", () => {
    const engine = makeEngine();
    const { result: player, scope } = runInScope(() => useEkoPlayer(engine));
    const snap = engine.getSnapshot();

    expect(player.value.state).toBe(snap.state);
    expect(player.value.paused).toBe(snap.paused);
    expect(player.value.index).toBe(snap.index);
    expect(player.value.queueLength).toBe(snap.queueLength);
    expect(player.value.track).toBe(snap.track);
    expect(player.value.duration).toBe(snap.duration);
    expect(player.value.volume).toBe(snap.volume);
    expect(player.value.muted).toBe(snap.muted);
    expect(player.value.lastTransition).toBe(snap.lastTransition);
    expect(player.value.sourceKind).toBe(snap.sourceKind);
    expect(player.value.shuffle).toBe(snap.shuffle);
    expect(player.value.repeat).toBe(snap.repeat);
    scope.stop();
  });

  it("updates .value when the engine's discrete state changes", async () => {
    restoreFetch = stubFetch();
    const engine = makeEngine();
    const { result: player, scope } = runInScope(() => useEkoPlayer(engine));
    const before = player.value;

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await nextTick();

    expect(player.value).not.toBe(before);
    expect(player.value.queueLength).toBe(1);
    expect(player.value.index).toBe(0);
    expect(player.value.track?.id).toBe("a");
    scope.stop();
  });

  it("is readonly: assigning to .value does not change it or touch the engine", () => {
    const engine = makeEngine();
    const { result: player, scope } = runInScope(() => useEkoPlayer(engine));
    const before = player.value;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // @ts-expect-error -- deliberately attempting a write the type forbids
    player.value = { ...before, paused: !before.paused };

    expect(player.value).toBe(before);
    expect(player.value.paused).toBe(before.paused);
    expect(engine.getSnapshot().paused).toBe(before.paused);

    warn.mockRestore();
    scope.stop();
  });

  describe("transport callbacks", () => {
    it("play() calls engine.play()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "play").mockResolvedValue(undefined);
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.play();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      scope.stop();
    });

    it("pause() calls engine.pause()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "pause").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.pause();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      scope.stop();
    });

    it("next() calls engine.next()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "next").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.next();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      scope.stop();
    });

    it("previous() calls engine.previous()", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "previous").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.previous();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      scope.stop();
    });

    it("skipTo(index) calls engine.skipTo(index)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "skipTo").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.skipTo(3);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(3);
      scope.stop();
    });

    it("seek(time) calls engine.seek(time)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "seek").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.seek(12.5);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(12.5);
      scope.stop();
    });

    it("setShuffle(on) calls engine.setShuffle(on)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setShuffle").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.setShuffle(true);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(true);
      scope.stop();
    });

    it("setRepeat(mode) calls engine.setRepeat(mode)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setRepeat").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.setRepeat("one");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("one");
      scope.stop();
    });

    it("setVolume(v) calls engine.setVolume(v)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setVolume").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.setVolume(0.4);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(0.4);
      scope.stop();
    });

    it("setMuted(muted) calls engine.setMuted(muted)", () => {
      const engine = makeEngine();
      const spy = vi.spyOn(engine, "setMuted").mockImplementation(() => {});
      const { result: player, scope } = runInScope(() => useEkoPlayer(engine));

      player.value.setMuted(true);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(true);
      scope.stop();
    });
  });

  it("scope.stop() leaves the engine with no subscribers", () => {
    const engine = makeEngine();
    expect(subscriberCount(engine)).toBe(0);

    const { scope } = runInScope(() => useEkoPlayer(engine));
    expect(subscriberCount(engine)).toBe(1);

    scope.stop();
    expect(subscriberCount(engine)).toBe(0);
  });

  it("re-seeds and re-subscribes when the engine ref it is given changes", async () => {
    const a = makeEngine();
    const b = makeEngine();
    const engineRef = shallowRef(a);

    const { result: player, scope } = runInScope(() => useEkoPlayer(engineRef));
    expect(player.value.state).toBe(a.getSnapshot().state);
    expect(subscriberCount(a)).toBe(1);
    expect(subscriberCount(b)).toBe(0);

    // Spy before the swap: transport methods are bound once, at swap time, so a spy
    // installed after swapping would replace `b.play` on the prototype but the already-
    // bound closure would still close over the original, pre-spy function.
    const spy = vi.spyOn(b, "play").mockResolvedValue(undefined);
    engineRef.value = b;
    await nextTick();

    expect(player.value.state).toBe(b.getSnapshot().state);
    // Swapping must drop engine A's subscription, not accumulate a second one.
    expect(subscriberCount(a)).toBe(0);
    expect(subscriberCount(b)).toBe(1);

    // Transport methods must be re-bound to the new engine, not still call the old one.
    player.value.play();
    expect(spy).toHaveBeenCalledTimes(1);

    scope.stop();
    expect(subscriberCount(b)).toBe(0);
  });
});

describe("useEkoTime", () => {
  it("reports a loaded track's duration before anything has played", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngineWithCtx();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));
    expect(time.duration.value).toBe(0);

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await nextTick();

    // The engine announces a loaded track with `durationchange`, not `timeupdate`, so a
    // composable listening only for the latter shows a zero-length track until the
    // listener presses play, which is the ordinary state of a player sitting idle.
    expect(time.duration.value).toBeCloseTo(0.5, 6);
    expect(time.currentTime.value).toBe(0);
    scope.stop();
  });
  it("returns refs with the engine's currentTime and duration", () => {
    const engine = makeEngine();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    expect(time.currentTime.value).toBe(engine.currentTime);
    expect(time.duration.value).toBe(engine.duration);
    scope.stop();
  });

  it("reflects the engine's position when set up after a load, before any playback", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngineWithCtx();

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    // A seek while paused moves `currentTime` and emits `timeupdate`, but nothing is set
    // up yet to hear it: the composable must pick this up from its own initial seed, since
    // this is the "no event has fired yet" case, not from having observed that event.
    engine.seek(0.15);

    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    expect(time.currentTime.value).toBeCloseTo(0.15, 3);
    expect(time.duration.value).toBeCloseTo(0.5, 3); // makeToneBuffer(0.5)
    scope.stop();
  });

  it("updates on successive timeupdate events while playing", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();

    // Only the engine's own per-frame loop is scheduled; useEkoTime runs no loop of its
    // own and relies entirely on the `timeupdate` event that loop emits.
    expect(raf.pendingCount()).toBe(1);

    ctx.currentTime = 0.2;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.2, 3);

    ctx.currentTime = 0.35;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.35, 3);
    scope.stop();
  });

  it("does not update after the engine pauses (no frame loop of its own)", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();

    ctx.currentTime = 0.2;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.2, 3);

    engine.pause();
    expect(raf.pendingCount()).toBe(0);

    // The clock keeps moving, as it would in a real browser, but nothing is left to fire:
    // pausing stops the engine's loop, so no further `timeupdate` reaches the composable.
    ctx.currentTime = 9;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.2, 3);
    scope.stop();
  });

  it("resumes updates after a pause/resume cycle", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();
    engine.pause();
    expect(raf.pendingCount()).toBe(0);

    await engine.play();

    // The engine's loop must be running again, or playback resumed with no way left to
    // reach this composable.
    expect(raf.pendingCount()).toBe(1);

    ctx.currentTime += 0.4;
    raf.fireFrame();

    expect(time.currentTime.value).toBeCloseTo(engine.currentTime, 3);
    scope.stop();
  });

  it("a volume change while playing does not disturb time updates or add a duplicate subscription", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    const { result: time, scope } = runInScope(() => useEkoTime(engine));

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();
    expect(timeupdateListenerCount(engine)).toBe(1);

    // A volume change publishes a new discrete snapshot. useEkoTime never subscribed to
    // that channel, so this must not add a second `timeupdate` listener.
    engine.setVolume(0.5);
    expect(timeupdateListenerCount(engine)).toBe(1);

    ctx.currentTime = 0.3;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.3, 3);
    scope.stop();
  });

  it("reseeds from the new engine when the engine ref it is given changes", async () => {
    restoreFetch = stubFetch();
    const a = makeEngineWithCtx();
    const b = makeEngineWithCtx();

    const ready = whenReady(a.engine);
    a.engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    a.engine.seek(0.3); // engine A sits at a non-zero position inside its 0.5s buffer

    const engineRef = shallowRef(a.engine);
    const { result: time, scope } = runInScope(() => useEkoTime(engineRef));
    expect(time.currentTime.value).toBeCloseTo(0.3, 6);
    expect(timeupdateListenerCount(a.engine)).toBe(1);
    expect(timeupdateListenerCount(b.engine)).toBe(0);

    // Engine B has no queue and has never played, so it will never emit a timeupdate on
    // its own. A composable that seeds only on first setup keeps showing engine A's 0.3
    // forever.
    engineRef.value = b.engine;
    await nextTick();

    expect(time.currentTime.value).toBe(0);
    expect(time.duration.value).toBe(0);
    // The subscription has to MOVE, not merely be added. Checking the values alone would
    // pass just as happily while engine A kept a listener for the life of the app, which
    // is a leak per swap and the kind nothing ever notices.
    expect(timeupdateListenerCount(a.engine)).toBe(0);
    expect(timeupdateListenerCount(b.engine)).toBe(1);

    scope.stop();
    expect(timeupdateListenerCount(b.engine)).toBe(0);
  });

  it("stopping the scope tears down the engine's timeupdate subscription, so no pending frame can reach it any more", async () => {
    restoreFetch = stubFetch();
    const raf = stubRaf();
    restoreRaf = raf.restore;
    const { ctx, engine } = makeEngineWithCtx();
    expect(timeupdateListenerCount(engine)).toBe(0);

    const { result: time, scope } = runInScope(() => useEkoTime(engine));
    expect(timeupdateListenerCount(engine)).toBe(1);

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();
    ctx.currentTime = 0.2;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.2, 3);
    // The engine's own per-frame loop has a frame pending while playing; that loop is not
    // this composable's to cancel, only its subscription to it is.
    expect(raf.pendingCount()).toBe(1);

    scope.stop();

    expect(timeupdateListenerCount(engine)).toBe(0);
    // The engine's own loop is still running (nothing here paused it) and will go on
    // emitting `timeupdate`, but nothing is listening any more: the composable's refs
    // must stay frozen at their last value, not follow the engine any further.
    ctx.currentTime = 9;
    raf.fireFrame();
    expect(time.currentTime.value).toBeCloseTo(0.2, 3);
  });
});
