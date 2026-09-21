import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

function setup() {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
  return { ctx, engine };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("subscription contract", () => {
  it("returns a referentially stable snapshot when nothing changes", () => {
    const { engine } = setup();
    const first = engine.getSnapshot();
    expect(engine.getSnapshot()).toBe(first);
    expect(engine.getSnapshot()).toBe(first);
  });

  it("returns a new object once something discrete changes", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const before = engine.getSnapshot();
    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    const after = engine.getSnapshot();

    expect(after).not.toBe(before);
    expect(after.duration).toBeCloseTo(0.5, 3);
    expect(after.track?.id).toBe("a");
    expect(after.sourceKind).toBe("buffer");
  });

  it("notifies subscribers on a discrete change and stops after unsubscribe", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    engine.setVolume(0.4);
    expect(listener).toHaveBeenCalled();
    expect(engine.getSnapshot().volume).toBeCloseTo(0.4, 6);

    unsubscribe();
    const callsAfter = listener.mock.calls.length;
    engine.setVolume(0.9);
    expect(listener.mock.calls.length).toBe(callsAfter);
  });

  it("does not notify when a setter changes nothing", () => {
    const { engine } = setup();
    engine.setVolume(0.5);
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setVolume(0.5); // same value
    expect(listener).not.toHaveBeenCalled();
  });

  it("tracks paused and the transition kind", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    expect(engine.getSnapshot().paused).toBe(true);
    await engine.play();
    expect(engine.getSnapshot().paused).toBe(false);
    expect(engine.getSnapshot().lastTransition).toBeNull();
  });

  it("keeps currentTime out of the snapshot, because it changes every frame", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    await engine.play();

    const before = engine.getSnapshot();
    ctx.currentTime = 0.3;
    expect(engine.currentTime).toBeCloseTo(0.3, 3);
    // Time moved, the snapshot did not.
    expect(engine.getSnapshot()).toBe(before);
    expect(before).not.toHaveProperty("currentTime");
  });

  it("reports queue length in the snapshot", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
      { id: "c", src: "/c.flac" },
    ]);
    await ready;
    expect(engine.getSnapshot().queueLength).toBe(3);
  });

  it("updates queue length when the queue changes", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
      { id: "c", src: "/c.flac" },
    ]);
    await ready;
    expect(engine.getSnapshot().queueLength).toBe(3);
    engine.setQueue([
      { id: "x", src: "/x.flac" },
      { id: "y", src: "/y.flac" },
    ]);
    expect(engine.getSnapshot().queueLength).toBe(2);
  });

  it("triggers a new snapshot when only queue length changes", async () => {
    restore = stubFetch();
    const { engine } = setup();
    const trackA = { id: "a", src: "/a.flac" };
    const trackB = { id: "b", src: "/b.flac" };
    const trackC = { id: "c", src: "/c.flac" };

    const ready = whenReady(engine);
    engine.setQueue([trackA, trackB]);
    await ready;
    const snapshotWith2 = engine.getSnapshot();
    expect(snapshotWith2.queueLength).toBe(2);

    engine.setQueue([trackA, trackB, trackC]);
    const snapshotWith3 = engine.getSnapshot();

    expect(snapshotWith3.queueLength).toBe(3);
    expect(snapshotWith3).not.toBe(snapshotWith2);
  });
});

describe("snapshot: shuffle and repeat", () => {
  it("reports the defaults", () => {
    const { engine } = setup();
    const snapshot = engine.getSnapshot();
    expect(snapshot.shuffle).toBe(false);
    expect(snapshot.repeat).toBe("none");
  });

  it("publishes a new snapshot when shuffle changes", () => {
    const { engine } = setup();
    const before = engine.getSnapshot();
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setShuffle(true);
    expect(listener).toHaveBeenCalled();
    const after = engine.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.shuffle).toBe(true);
  });

  it("publishes a new snapshot when repeat changes", () => {
    const { engine } = setup();
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setRepeat("all");
    expect(listener).toHaveBeenCalled();
    expect(engine.getSnapshot().repeat).toBe("all");
  });

  it("does not notify when setShuffle changes nothing", () => {
    const { engine } = setup();
    engine.setShuffle(true);
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setShuffle(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify when setRepeat changes nothing", () => {
    const { engine } = setup();
    engine.setRepeat("all");
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setRepeat("all");
    expect(listener).not.toHaveBeenCalled();
  });
});
