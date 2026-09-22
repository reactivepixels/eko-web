import { describe, it, expect, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, makeToneBuffer, stubFetch, sourceGains } from "./mock-audio";

/**
 * `fadeOutAndStop()` ramps the shared fadeGain to 0 over the (default, 10ms) fade and
 * schedules the outgoing source to stop at that ramp's end. When a manual skip's decode
 * resolves faster than that (a cached file easily does), `loadIndex()` used to tear the
 * outgoing source down immediately on decode success: its gain node was disconnected right
 * there, well before the ramp actually reached silence, which cuts the fade audibly. The
 * fix defers that teardown to the ramp's own end, the same way `clearArmed()` already
 * defers the armed track's teardown.
 *
 * `transition: "gap"` throughout: gapless/crossfade arming is a separate mechanism and
 * would otherwise proactively decode and connect the next track on its own, which is not
 * what these tests are about.
 */

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("fade-then-dispose ordering on a manual skip", () => {
  it("keeps the outgoing source connected until the fade's ramp end, not until decode success", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "gap",
    });

    const readyA = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await readyA;
    await engine.play();

    const outgoingSource = ctx.sources[0]!;
    const outgoingGain = sourceGains(ctx)[0]!;
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    const readyB = whenReady(engine);
    engine.next();
    await readyB;

    // The skip's decode has already resolved (the mocks decode synchronously), so
    // loadIndex() has already run its disposal branch for the outgoing track. The ramp it
    // scheduled is 10ms (the default fade) ahead of ctx.currentTime (0), and no real time
    // has passed yet.
    expect(outgoingSource.stopped).toBe(true);
    expect(outgoingSource.stopWhen).toBeCloseTo(0.01, 6);

    // The fade has not reached silence yet: the outgoing source's gain node must still be
    // connected, or the fade was cut short right here.
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    // Now let real time pass the ramp's end: only now should the deferred teardown run.
    await wait(20);
    expect(outgoingGain.connections.length).toBe(0);
  });

  it("still disposes the outgoing source immediately when no fade is in flight", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "gap",
    });

    const readyA = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await readyA;
    // Deliberately not playing: a skip with nothing audible has no fade to protect, so the
    // outgoing source must still be torn down right away, or it leaks until a timer nobody
    // is waiting for happens to fire.
    const outgoingGain = sourceGains(ctx)[0]!;
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    const readyB = whenReady(engine);
    engine.next();
    await readyB;

    expect(outgoingGain.connections.length).toBe(0);
  });

  it("replacing the queue outright while a track is playing also defers disposal to the fade's end", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "gap",
    });

    const readyA = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await readyA;
    await engine.play();

    const outgoingGain = sourceGains(ctx)[0]!;
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    // setQueue() (load()'s underlying call) interrupting a playing track goes through the
    // same fade-then-load path as a manual skip, just via startLoad() instead of
    // commitSkip().
    const readyC = whenReady(engine);
    engine.setQueue([{ id: "c", src: "/c.flac" }]);
    await readyC;

    expect(outgoingGain.connections.length).toBeGreaterThan(0);
    await wait(20);
    expect(outgoingGain.connections.length).toBe(0);
  });
});

describe("fade-then-dispose ordering when the queue is emptied", () => {
  it("keeps the outgoing source connected until the fade's ramp end", async () => {
    restoreFetch = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "gap",
    });

    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();

    const outgoingSource = ctx.sources[0]!;
    const outgoingGain = sourceGains(ctx)[0]!;
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    // Emptying the queue fades the playing track out, exactly as a skip does. The
    // empty-queue branch returns before any load, so it owns its own teardown, and it
    // must honour that fade rather than cutting on the spot.
    const at = ctx.currentTime;
    engine.setQueue([]);

    expect(outgoingSource.stopWhen).not.toBeNull();
    expect(outgoingSource.stopWhen!).toBeGreaterThan(at);
    expect(outgoingGain.connections.length).toBeGreaterThan(0);

    // Once the ramp has passed, the deferred teardown runs and the node is released.
    await wait(40);
    expect(outgoingGain.connections.length).toBe(0);
  });
});
