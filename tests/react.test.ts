// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { useEkoPlayer, type EkoPlayer } from "../src/react/index";
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

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
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
