import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import {
  measureLoudnessLufs,
  samplePeak,
  computeNormalizationGain,
  dbToLinear,
} from "../src/engine/loudness";
import { MockAudioContext, MockMediaElement, makeToneBuffer, stubFetch } from "./mock-audio";

function makeEngine(buffer = makeToneBuffer(0.5), opts: Record<string, unknown> = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = buffer;
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext, ...opts });
  return { ctx, engine };
}

/** Resolve once the given engine emits its `n`th `canplay`. */
function whenNthCanplay(engine: EkoWebEngine, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const off = engine.on("canplay", () => {
      count += 1;
      if (count === n) {
        off();
        resolve();
      }
    });
  });
}

function whenReady(engine: EkoWebEngine): Promise<void> {
  return whenNthCanplay(engine, 1);
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("normalize option coercion", () => {
  it('defaults to "auto" when the option is omitted', () => {
    const { engine } = makeEngine();
    expect(engine.config.normalize).toBe("auto");
  });

  it('maps true onto "auto"', () => {
    const { engine } = makeEngine(undefined, { normalize: true });
    expect(engine.config.normalize).toBe("auto");
  });

  it("keeps false as false", () => {
    const { engine } = makeEngine(undefined, { normalize: false });
    expect(engine.config.normalize).toBe(false);
  });

  it('passes "tags" and "measure" straight through', () => {
    expect(makeEngine(undefined, { normalize: "tags" }).engine.config.normalize).toBe("tags");
    expect(makeEngine(undefined, { normalize: "measure" }).engine.config.normalize).toBe("measure");
  });
});

describe('normalize: "tags" on the buffer path', () => {
  it("uses gainDb when the track has one", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine(makeToneBuffer(0.1), { normalize: "tags" });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac", gainDb: -6 }]);
    await ready;
    // -6 dB is roughly 0.501 linear; the 0.1 peak leaves plenty of clamp headroom.
    expect(engine.normGain).toBeCloseTo(0.5012, 3);
  });

  it("does NOT measure the buffer when gainDb is absent, falling back to unity instead", async () => {
    restoreFetch = stubFetch();
    const buffer = makeToneBuffer(0.5);
    // What measuring this exact buffer would produce, so the assertion below is meaningful:
    // if "tags" mode measured anyway, normGain would land here, not at 1.
    const channels = [buffer.getChannelData(0)];
    const measured = computeNormalizationGain(
      measureLoudnessLufs(channels, buffer.sampleRate),
      -16,
      samplePeak(channels),
    );
    expect(measured).not.toBeCloseTo(1, 3);

    const { engine } = makeEngine(buffer, { normalize: "tags" });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    expect(engine.normGain).toBe(1);
  });
});

describe('normalize: "measure" on the buffer path', () => {
  it("measures the decoded buffer and ignores gainDb even when present", async () => {
    restoreFetch = stubFetch();
    const buffer = makeToneBuffer(0.5);
    const channels = [buffer.getChannelData(0)];
    const measured = computeNormalizationGain(
      measureLoudnessLufs(channels, buffer.sampleRate),
      -16,
      samplePeak(channels),
    );
    const tagGain = dbToLinear(-6);
    expect(measured).not.toBeCloseTo(tagGain, 3);

    const { engine } = makeEngine(buffer, { normalize: "measure" });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac", gainDb: -6 }]);
    await ready;
    expect(engine.normGain).toBeCloseTo(measured, 6);
    expect(engine.normGain).not.toBeCloseTo(tagGain, 3);
  });
});

describe('normalize: "auto" on the buffer path', () => {
  it("prefers gainDb when present", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine(makeToneBuffer(0.1), { normalize: "auto" });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac", gainDb: -6 }]);
    await ready;
    expect(engine.normGain).toBeCloseTo(0.5012, 3);
  });

  it("measures the buffer when gainDb is absent", async () => {
    restoreFetch = stubFetch();
    const buffer = makeToneBuffer(0.5);
    const channels = [buffer.getChannelData(0)];
    const measured = computeNormalizationGain(
      measureLoudnessLufs(channels, buffer.sampleRate),
      -16,
      samplePeak(channels),
    );
    const { engine } = makeEngine(buffer, { normalize: "auto" });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac" }]);
    await ready;
    expect(engine.normGain).toBeCloseTo(measured, 6);
  });
});

describe("normalize: false", () => {
  it("stays at unity on the buffer path even with a gainDb tag", async () => {
    restoreFetch = stubFetch();
    const { engine } = makeEngine(makeToneBuffer(0.5), { normalize: false });
    const ready = whenReady(engine);
    engine.setQueue([{ src: "/a.flac", gainDb: -6 }]);
    await ready;
    expect(engine.normGain).toBe(1);
  });

  it("stays at unity on the element path and never warns", async () => {
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const el = new MockMediaElement();
      setTimeout(() => el.fireLoadedMetadata(120), 0);
      return el;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { engine } = makeEngine(undefined, { normalize: false });
      const ready = whenReady(engine);
      engine.setQueue([{ src: "/long.flac", source: "element" }]);
      await ready;
      expect(engine.normGain).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});

describe('normalize: "tags" on the element path', () => {
  it("uses gainDb when present", async () => {
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const el = new MockMediaElement();
      setTimeout(() => el.fireLoadedMetadata(120), 0);
      return el;
    } as unknown as typeof Audio;

    try {
      const { engine } = makeEngine(undefined, { normalize: "tags" });
      const ready = whenReady(engine);
      engine.setQueue([{ src: "/long.flac", source: "element", gainDb: -6 }]);
      await ready;
      expect(engine.normGain).toBeCloseTo(dbToLinear(-6), 6);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
    }
  });

  it("runs at unity and does NOT warn when gainDb is absent, since this mode never asked to measure", async () => {
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const el = new MockMediaElement();
      setTimeout(() => el.fireLoadedMetadata(120), 0);
      return el;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { engine } = makeEngine(undefined, { normalize: "tags" });
      const ready = whenReady(engine);
      engine.setQueue([{ src: "/long.flac", source: "element" }]);
      await ready;
      expect(engine.normGain).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});

describe('normalize: "measure" on the element path', () => {
  it("ignores gainDb (there is no buffer to measure either way) and warns once", async () => {
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const el = new MockMediaElement();
      setTimeout(() => el.fireLoadedMetadata(120), 0);
      return el;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { engine } = makeEngine(undefined, { normalize: "measure" });
      const ready = whenReady(engine);
      engine.setQueue([{ src: "/long.flac", source: "element", gainDb: -6 }]);
      await ready;
      expect(engine.normGain).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});

describe('normalize: "auto" on the element path with no gainDb', () => {
  it("runs at unity and warns exactly once across two tracks in the same queue", async () => {
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const el = new MockMediaElement();
      setTimeout(() => el.fireLoadedMetadata(120), 0);
      return el;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { engine } = makeEngine(undefined, { normalize: "auto" });
      const firstReady = whenReady(engine);
      // Two tracks force the element strategy explicitly, so neither pays for (or needs)
      // the auto-selection HEAD probe; each load builds its own fresh
      // ElementSourceStrategy (see select.ts), which is exactly why the dedup guard has to
      // live on the engine and not on the strategy instance.
      engine.setQueue([
        { src: "/one.flac", source: "element" },
        { src: "/two.flac", source: "element" },
      ]);
      await firstReady;
      expect(engine.normGain).toBe(1);

      const secondReady = whenReady(engine);
      engine.next();
      await secondReady;
      expect(engine.normGain).toBe(1);

      // Two tracks loaded through a path that cannot measure and carry no tag: a guard
      // that resets per track (or per strategy instance) would warn twice here. This is
      // the assertion that would fail if that guard were removed or scoped too narrowly.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });
});

describe("engine boundary: no import of the replaygain subpath", () => {
  it("never imports from ../replaygain anywhere under src/engine", () => {
    const engineDir = join(__dirname, "..", "src", "engine");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const contents = readFileSync(full, "utf8");
        // Matches `from "...replaygain..."` and `require("...replaygain...")` at any
        // relative depth, so this would catch a real import regardless of which file
        // under src/engine added it or how many `../` it takes to reach the subpath.
        const importPattern = /(?:from\s+|require\()\s*["'][^"']*replaygain[^"']*["']/i;
        if (importPattern.test(contents)) offenders.push(full);
      }
    }

    walk(engineDir);
    expect(offenders).toEqual([]);
  });

  it("the scanner actually catches an import when one is present (sanity check)", () => {
    const importPattern = /(?:from\s+|require\()\s*["'][^"']*replaygain[^"']*["']/i;
    expect(importPattern.test('import { readReplayGain } from "../replaygain";')).toBe(true);
    expect(importPattern.test('import { readReplayGain } from "../../replaygain/index";')).toBe(
      true,
    );
    expect(importPattern.test('const x = require("../replaygain");')).toBe(true);
    expect(importPattern.test('import { foo } from "../queue/queue";')).toBe(false);
  });
});
