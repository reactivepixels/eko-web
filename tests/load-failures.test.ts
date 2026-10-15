import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A context whose decodes fail for the srcs named, by counting fetches per URL. */
function contextFailing(bad: Set<number>) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  let n = 0;
  ctx.decodeAudioData = async () => {
    n++;
    if (bad.has(n)) throw new Error("bad bytes");
    return ctx.nextBuffer!;
  };
  return ctx;
}

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("load failures", () => {
  it("a new queue whose first track fails does not replay the previous queue's track", async () => {
    restore = stubFetch();
    // Decode 1: a (old queue). Decode 2: c (new queue's first track), fails.
    const ctx = contextFailing(new Set([2]));
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue([{ id: "a", src: "/a.flac" }]);
    await ready;
    await engine.play();
    await flush();
    const started = ctx.sources.length;

    engine.setQueue([{ id: "c", src: "/c.flac" }]);
    await engine.play();
    await flush();
    await flush();

    expect(engine.state).toBe("error");
    expect(ctx.sources.length).toBe(started);

    // And a later play() press still has nothing of this queue to play.
    await engine.play();
    expect(ctx.sources.length).toBe(started);
    expect(engine.state).toBe("error");
  });

  it("a track that fails at a gap boundary is skipped, and the next one plays", async () => {
    restore = stubFetch();
    // Decode 1: a. Decode 2: b at the boundary, fails. Decode 3: c.
    const ctx = contextFailing(new Set([2]));
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, transition: "gap" });
    const tracks = [
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
      { id: "c", src: "/c.flac" },
    ];
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const changes = vi.fn();
    engine.on("trackchange", changes);
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded();
    for (let i = 0; i < 6; i++) await flush();

    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ index: 2, track: tracks[2] }));
    expect(engine.currentIndex).toBe(2);
    expect(engine.state).toBe("playing");
  });

  it("settles when every remaining track fails, even under repeat-all", async () => {
    restore = stubFetch();
    const ctx = contextFailing(new Set([2, 3, 4, 5, 6, 7, 8]));
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, transition: "gap" });
    engine.setRepeat("all");
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
      { id: "c", src: "/c.flac" },
    ]);
    await ready;
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded();
    for (let i = 0; i < 20; i++) await flush();

    expect(engine.state).toBe("error");
    expect(ctx.sources.length).toBe(1);
  });

  it("a failed manual skip reports no track change", async () => {
    restore = stubFetch();
    const ctx = contextFailing(new Set([2]));
    const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, transition: "gap" });
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await ready;
    const changes = vi.fn();
    engine.on("trackchange", changes);

    engine.next();
    for (let i = 0; i < 4; i++) await flush();

    expect(changes).not.toHaveBeenCalled();
    expect(engine.currentIndex).toBe(0);
  });
});
