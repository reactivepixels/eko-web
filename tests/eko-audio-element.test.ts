import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoAudioElement } from "../src/adapters/eko-audio-element";
import { MockAudioContext, MockMediaElement, makeToneBuffer, stubFetch } from "./mock-audio";

function makeEl() {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  const el = new EkoAudioElement({ context: ctx as unknown as AudioContext });
  return { ctx, el };
}

/** Set src and resolve when the facade reports it can play. */
function loadVia(el: EkoAudioElement, src = "/a.flac"): Promise<void> {
  return new Promise((res) => {
    el.addEventListener("canplay", () => res());
    el.src = src;
  });
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("EkoAudioElement", () => {
  it("loads via the src setter and fires canplay/canplaythrough", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    const canplaythrough = vi.fn();
    el.addEventListener("canplaythrough", canplaythrough);
    await loadVia(el);
    expect(canplaythrough).toHaveBeenCalled();
    expect(el.duration).toBeCloseTo(0.5, 3);
    expect(el.src).toBe("/a.flac");
  });

  it("play / pause reflect the engine's paused state", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    await loadVia(el);
    expect(el.paused).toBe(true);
    await el.play();
    expect(el.paused).toBe(false);
    el.pause();
    expect(el.paused).toBe(true);
  });

  it("volume and muted setters drive the engine", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    await loadVia(el);
    await el.play();
    el.volume = 0.4;
    expect(el.volume).toBeCloseTo(0.4, 6);
    el.muted = true;
    expect(el.muted).toBe(true);
    el.muted = false;
    expect(el.muted).toBe(false);
  });

  it("setting currentTime seeks and dispatches seeked + timeupdate", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    await loadVia(el);
    const seeked = vi.fn();
    const timeupdate = vi.fn();
    el.addEventListener("seeked", seeked);
    el.addEventListener("timeupdate", timeupdate);
    el.currentTime = 0.2;
    expect(seeked).toHaveBeenCalled();
    expect(timeupdate).toHaveBeenCalled();
  });

  it("removeEventListener detaches a listener", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    await loadVia(el);
    const tu = vi.fn();
    el.addEventListener("timeupdate", tu);
    el.removeEventListener("timeupdate", tu);
    el.currentTime = 0.1;
    expect(tu).not.toHaveBeenCalled();
  });

  it("exposes a TimeRanges-like buffered once decoded", async () => {
    restore = stubFetch();
    const { el } = makeEl();
    await loadVia(el);
    expect(el.buffered.length).toBe(1);
    expect(el.buffered.end(0)).toBeCloseTo(0.5, 3);
    expect(el.readyState).toBe(4); // HAVE_ENOUGH_DATA: the buffer strategy has it all
  });

  it("reports readyState/buffered honestly for the streaming (element) path, unlike the buffer path", async () => {
    // A large enough Content-Length, with a tiny bufferMaxBytes, forces the auto-select
    // heuristic onto the element strategy.
    restore = stubFetch(true, 200, 100 * 1024 * 1024);
    const ctx = new MockAudioContext();
    const el = new EkoAudioElement({ context: ctx as unknown as AudioContext, bufferMaxBytes: 1 });

    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(3600), 0);
      return element;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await loadVia(el, "/long.flac");

      // HAVE_CURRENT_DATA (2), not HAVE_ENOUGH_DATA (4): eko-web cannot promise the rest
      // of a streamed file is already available the way it can for a decoded buffer.
      expect(el.readyState).toBe(2);
      // Nothing has actually downloaded yet (per the mock element), so this must not
      // claim [0, duration] the way the pre-fix code always did.
      expect(el.buffered.length).toBe(0);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});
