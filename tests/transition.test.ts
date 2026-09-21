import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, MockMediaElement, makeToneBuffer, stubFetch } from "./mock-audio";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

/** Resolve with the next trackchange payload, so tests never guess at tick counts. */
function nextTrackChange(
  engine: EkoWebEngine,
): Promise<{ index: number; track: unknown; transition: string }> {
  return new Promise((res) => {
    const off = engine.on("trackchange", (payload) => {
      off();
      res(payload);
    });
  });
}

function setup(options = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, ...options });
  const tracks = [
    { id: "a", src: "/a.flac" },
    { id: "b", src: "/b.flac" },
  ];
  return { ctx, engine, tracks };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("transition reporting", () => {
  it("reports a gapless promotion as gapless", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const changed = vi.fn();
    engine.on("trackchange", changed);
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded();
    expect(changed).toHaveBeenCalledWith({
      index: 1,
      track: tracks[1],
      transition: "gapless",
    });
    expect(engine.lastTransition).toBe("gapless");
  });

  it("does not arm anything when the transition is gap", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1); // current only, nothing armed
  });

  it("still advances the queue with a gap, and says so", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    // Await the event rather than guessing how many ticks the reload takes.
    const changed = nextTrackChange(engine);
    ctx.sources[0]!.fireEnded();
    expect(await changed).toEqual({ index: 1, track: tracks[1], transition: "gap" });
    expect(engine.currentIndex).toBe(1);
    expect(engine.lastTransition).toBe("gap");
    expect(engine.state).not.toBe("ended");
  });

  it("refuses to arm when the source cannot be sample-accurate", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup();
    // The element strategy calls `new Audio()`, which does not exist in Node, so stand one
    // up for the duration of this test and announce metadata as soon as it is built.
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    };
    try {
      const ready = whenReady(engine);
      engine.setQueue(tracks.map((t) => ({ ...t, source: "element" as const })));
      await ready;
      await engine.play();
      await flush();
      await flush();

      // The element is playing, but nothing was armed: no buffer source was ever built.
      expect(ctx.sources.length).toBe(0);
      expect(ctx.mediaSources.length).toBe(1);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
    }
  });

  it("reports a manual skip as a gap", async () => {
    restore = stubFetch();
    const { engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;

    const changed = nextTrackChange(engine);
    engine.next();
    expect(await changed).toEqual({ index: 1, track: tracks[1], transition: "gap" });
    expect(engine.lastTransition).toBe("gap");
  });

  it("starts with no transition reported", () => {
    const { engine } = setup();
    expect(engine.lastTransition).toBeNull();
  });

  it("does not resume playback if pause() is called while a gap-advance is loading", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // Track A ends. The engine starts loading track B in the background (advanceWithGap),
    // which is asynchronous. Before that load settles, the consumer asks to pause.
    ctx.sources[0]!.fireEnded();
    engine.pause();

    await flush();
    await flush();

    // The load completed and the queue advanced, but the explicit pause during the load
    // must win: playback must not resume against the consumer's request.
    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(true);
    expect(engine.state).not.toBe("playing");
    expect(ctx.sources.length).toBe(1); // no new source was ever started
  });
});

describe("other transport calls during a gap-advance", () => {
  it("play() does not restart the old, already-ended source", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // Track A ends and the engine starts loading track B in the background. Before that
    // settles, a play/pause toggle reacting to `engine.paused === true` calls play() again.
    ctx.sources[0]!.fireEnded();
    expect(engine.paused).toBe(true); // advancing also reads as paused
    void engine.play();

    // If play() wrongly restarted the stale source, a second BufferSourceNode would exist
    // right now, immediately, well before track B's own load could possibly have settled.
    expect(ctx.sources.length).toBe(1);

    await flush();
    await flush();

    // Track B's own load finishes and resumes normally: exactly one further source, not two.
    expect(ctx.sources.length).toBe(2);
    expect(engine.currentIndex).toBe(1);
    expect(engine.state).toBe("playing");
  });

  it("next() during a gap-advance does not double-load or double-report the boundary", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    const changed = vi.fn();
    engine.on("trackchange", changed);

    // Track A ends (starts loading track B in the background), then the consumer taps
    // next() before that load settles. next() targets the same index the advance is
    // already loading, since `currentIndex` has not moved yet.
    ctx.sources[0]!.fireEnded();
    engine.next();

    await flush();
    await flush();
    await flush();

    expect(engine.currentIndex).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({ index: 1, track: tracks[1], transition: "gap" });
  });

  it("next() that interrupts a gap-advance resumes playback instead of leaving it stuck paused", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    // Track A ends (starts loading track B in the background), then the consumer taps
    // next() before that load settles, the same window as the double-report test above.
    // `_paused` was forced true purely as the advance's own bookkeeping; the user was
    // still mid-playback, so the skip that lands must not leave the engine stuck paused.
    ctx.sources[0]!.fireEnded();
    engine.next();

    await flush();
    await flush();
    await flush();

    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(false);
    expect(engine.state).toBe("playing");
  });

  it("next() that interrupts a gap-advance stays paused if pause() was called during that advance", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    // Track A ends (starts loading track B in the background). The consumer explicitly
    // pauses during that load, then taps next() before the load settles. The explicit
    // pause is a real request to stop, not internal bookkeeping, so it must still win.
    ctx.sources[0]!.fireEnded();
    engine.pause();
    engine.next();

    await flush();
    await flush();
    await flush();

    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(true);
    expect(engine.state).not.toBe("playing");
  });

  it("setQueue() during a gap-advance leaves the engine on the new queue", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    const changed = vi.fn();
    const canplayed = vi.fn();
    engine.on("trackchange", changed);
    engine.on("canplay", canplayed);
    const newTracks = [{ id: "c", src: "/c.flac" }];

    // Track A ends (starts loading track B in the background), then the consumer replaces
    // the whole queue with a single, unrelated track before that load settles.
    ctx.sources[0]!.fireEnded();
    engine.setQueue(newTracks);
    await flush();
    await flush();
    await flush();

    // The engine must be on the new, single-track queue, not track B's index (which would
    // now be out of range) and not a stray trackchange for a track it never really reached.
    expect(engine.currentIndex).toBe(0);
    expect(engine.state).toBe("ready");
    expect(changed).not.toHaveBeenCalled();
    // Exactly one canplay, for the new queue's only track: the superseded load for the old
    // queue's track B must never reach far enough to report itself, regardless of which of
    // the two concurrent loads happens to settle first.
    expect(canplayed).toHaveBeenCalledTimes(1);
    expect(canplayed).toHaveBeenCalledWith({ index: 0 });
    expect(ctx.sources.length).toBe(1); // track A's source only; B was never started
  });

  it("setQueue() during a manual skip leaves the engine on the new queue, no stray trackchange", async () => {
    restore = stubFetch();
    const { engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;

    const changed = vi.fn();
    const canplayed = vi.fn();
    engine.on("trackchange", changed);
    engine.on("canplay", canplayed);
    // Same length as the original queue and long enough that index 1 is in range, so a
    // stray trackchange from the superseded skip would report a real (but wrong) track
    // instead of being saved by an out-of-range lookup.
    const newTracks = [
      { id: "c", src: "/c.flac" },
      { id: "d", src: "/d.flac" },
    ];

    // A manual skip starts loading track B, then the consumer replaces the whole queue
    // before that load settles. The same window this whole suite is about, but between
    // two consumer-triggered calls instead of a natural end and a consumer call.
    engine.next();
    engine.setQueue(newTracks);
    await flush();
    await flush();
    await flush();

    expect(engine.currentIndex).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(canplayed).toHaveBeenCalledTimes(1);
    expect(canplayed).toHaveBeenCalledWith({ index: 0 });
  });

  it("destroy() during a gap-advance does not let the advance resume playback afterward", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // Track A ends and the engine starts loading track B in the background. Before that
    // settles, the consumer unmounts and destroys the engine, which is a normal thing to
    // do right as a track naturally ends, not a contrived edge case.
    ctx.sources[0]!.fireEnded();
    engine.destroy();

    await flush();
    await flush();

    // The advance must not resurrect playback, or the graph/context machinery destroy()
    // just tore down, after destroy(): no further source was ever built, and no second
    // EkoGraph (a fresh rgGain/fadeGain/userGain triple) was ever constructed.
    expect(ctx.sources.length).toBe(1);
    expect(ctx.gains.length).toBe(3);
    expect(engine.state).not.toBe("playing");
  });

  it("a pause requested during a superseded advance does not suppress a later, unrelated advance's resume", async () => {
    restore = stubFetch();
    const { ctx, engine } = setup({ transition: "gap" });
    const firstTracks = [
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ];
    const ready = whenReady(engine);
    engine.setQueue(firstTracks);
    await ready;
    await engine.play();
    await flush();

    // Track A ends: an advance starts loading track B in the background. The consumer
    // pauses during that load (the flag this test is about gets set here), then replaces
    // the whole queue before the advance's load ever settles, superseding it without
    // letting it finish or resume anything itself.
    ctx.sources[0]!.fireEnded();
    engine.pause();

    const secondTracks = [
      { id: "c", src: "/c.flac" },
      { id: "d", src: "/d.flac" },
    ];
    const secondReady = whenReady(engine);
    engine.setQueue(secondTracks);
    await secondReady;
    await engine.play();
    await flush();
    await flush();
    expect(ctx.sources.length).toBe(2); // track A's source, then track C's

    // Track C ends naturally: a second, unrelated advance loads track D. If the pause
    // requested during the first (superseded) advance had leaked, this advance would
    // come out stuck paused for no reason visible anywhere in the new queue or the
    // consumer's own calls.
    ctx.sources[1]!.fireEnded();
    await flush();
    await flush();
    await flush();

    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(false);
    expect(engine.state).toBe("playing");
  });

  it("a skip's own resume is not blocked by a superseded advance that has not settled yet", async () => {
    // Both loads fetch the same URL (track B), since next() targets the index the advance
    // is already loading. In a real browser there is no guarantee the advance's own fetch,
    // even though it started first, resolves before the skip's later one: this test forces
    // the inverted order by holding the advance's fetch open while the skip's own fetch,
    // for the same track, resolves normally.
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5);
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, transition: "gap" });
    const tracks = [
      { id: "a", src: "/a.flac", source: "buffer" as const },
      { id: "b", src: "/b.flac", source: "buffer" as const },
    ];

    let fetchCount = 0;
    const staleFetchGate: { release: (() => void) | null } = { release: null };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount++;
      const response = {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
      if (fetchCount === 2) {
        // The advance's own fetch for track B: hold it open.
        await new Promise<void>((resolve) => {
          staleFetchGate.release = () => resolve();
        });
      }
      return response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };

    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // Track A ends: the advance's fetch for track B is call #2, held open. The consumer
    // taps next() immediately, superseding the advance; the skip's own fetch for track B,
    // issued right after, is call #3, which resolves normally, so it finishes well before
    // the held-open call #2 ever does.
    ctx.sources[0]!.fireEnded();
    engine.next();

    await flush();
    await flush();
    await flush();

    // The skip's own load has already completed. It must resume playback now, even though
    // the advance it superseded has still not settled.
    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(false);
    expect(engine.state).toBe("playing");

    // Letting the stale advance's fetch finish afterward must change nothing.
    staleFetchGate.release?.();
    await flush();
    await flush();
    expect(engine.paused).toBe(false);
    expect(engine.currentIndex).toBe(1);
  });
});

describe("pending intent during a load", () => {
  // These three windows (the very first load from setQueue(), a manual skip's own load,
  // and a gap-advance's load) are all the same mechanism now: `loading` plus one
  // `pendingIntent`, checked once the owning load settles. The gap-advance side of this is
  // covered above; these cover the other two, which a single boolean (`playRequested`) and
  // a token-blind `wasPlaying` snapshot used to get wrong.

  it("honours pause() called while the very first load (from setQueue) is still in flight", async () => {
    restore = stubFetch();
    const { engine, tracks } = setup();
    const ready = whenReady(engine);
    engine.setQueue(tracks);

    // Track A's fetch/decode has not resolved yet. Ask to play, then change your mind
    // before it does: the first interaction anyone has with this library.
    void engine.play();
    engine.pause();

    await ready;
    await flush();

    expect(engine.paused).toBe(true);
    expect(engine.state).not.toBe("playing");
  });

  it("play() during the very first load does not start anything until the load settles", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);

    void engine.play();
    // The fetch/decode for track A is still in flight: nothing can have started yet.
    expect(ctx.sources.length).toBe(0);

    await ready;
    await flush();

    expect(ctx.sources.length).toBe(1);
    expect(engine.state).toBe("playing");
  });

  it("honours pause() called while a manual skip's own load is in flight", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    // next() starts loading track B. Before that settles, the consumer changes their mind:
    // not a gap-advance interrupting anything, the skip's own load.
    engine.next();
    engine.pause();

    await flush();
    await flush();

    expect(engine.currentIndex).toBe(1);
    expect(engine.paused).toBe(true);
    expect(engine.state).not.toBe("playing");
  });

  it("play() during a manual skip's own load does not restart the old, faded-out source", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup({ transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();
    expect(ctx.sources.length).toBe(1);

    engine.next(); // starts loading track B; the skip's own load is now in flight
    void engine.play(); // redundant, already resuming once the load settles

    // If play() wrongly restarted the old source immediately, a second source would exist
    // right now, well before track B's load could possibly have settled.
    expect(ctx.sources.length).toBe(1);

    await flush();
    await flush();

    expect(ctx.sources.length).toBe(2); // exactly one further source, once the load settles
    expect(engine.currentIndex).toBe(1);
    expect(engine.state).toBe("playing");
  });
});
