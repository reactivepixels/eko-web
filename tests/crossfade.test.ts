import { describe, it, expect, vi, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { trackEndTime } from "../src/engine/scheduling";
import {
  MockAudioContext,
  MockMediaElement,
  makeToneBuffer,
  stubFetch,
  sourceGains,
} from "./mock-audio";

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

function setup(trackSeconds: number, options: Record<string, unknown> = {}) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5, trackSeconds);
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

describe("crossfade", () => {
  it("arms the next source before the boundary, by the configured overlap", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    expect(ctx.sources.length).toBe(2); // current + armed
    const endTime = trackEndTime(0, 3, 0); // started at ctx 0, 3s track → ends at 3
    // Gapless would arm at endTime; crossfade arms 1s earlier.
    expect(ctx.sources[1]!.startWhen).toBeCloseTo(endTime - 1, 6);
    expect(ctx.sources[1]!.startWhen).not.toBeCloseTo(endTime, 6);
  });

  it("ramps the outgoing gain to 0 and the incoming gain up to its own normGain across the overlap", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    // Both tracks decode the same buffer under the same settings, so they share a normGain;
    // capture it while `current` is still track A, before the boundary promotes B.
    const normGain = engine.normGain;
    await engine.play();
    await flush();

    const endTime = trackEndTime(0, 3, 0);
    const startAt = endTime - 1;
    const [outgoing, incoming] = sourceGains(ctx);
    expect(outgoing).toBeDefined();
    expect(incoming).toBeDefined();

    // Outgoing: still at its own normGain right as the overlap begins, ramped fully to
    // silence by the boundary, and genuinely partway down at the midpoint (not a step).
    expect(outgoing!.gain.valueAt(startAt)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(startAt + 0.5)).toBeCloseTo(normGain / 2, 6);
    expect(outgoing!.gain.valueAt(endTime)).toBeCloseTo(0, 6);

    // Incoming: silent until the overlap begins, then ramps up to its OWN normGain (not 1)
    // by the boundary, and is genuinely partway up at the midpoint.
    expect(incoming!.gain.valueAt(startAt)).toBeCloseTo(0, 6);
    expect(incoming!.gain.valueAt(startAt + 0.5)).toBeCloseTo(normGain / 2, 6);
    expect(incoming!.gain.valueAt(endTime)).toBeCloseTo(normGain, 6);
  });

  it("clamps the overlap to what remains of the outgoing track, never starting in the past", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(2, { transition: "crossfade", crossfadeSeconds: 3 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush(); // arms B; at this instant remaining == duration (2s), so overlap clamps to 2

    // Simulate the outgoing track already being most of the way played by moving the mock
    // clock forward, then force a fresh arm (switching to repeat "one" changes what plays
    // next from index 1 to index 0, without touching the current source's own start time).
    // `remaining` at the moment of this re-arm is now far under both crossfadeSeconds (3)
    // and the track's own duration (2): only 0.5s of playback is actually left.
    ctx.currentTime = 1.5;
    engine.setRepeat("one");
    await flush();

    const endTime = trackEndTime(0, 2, 0); // unchanged: current's own start/duration didn't move
    const armed = ctx.sources[ctx.sources.length - 1]!;
    // Clamped to the 0.5s actually remaining, so it starts at ctx.currentTime (1.5), not at
    // endTime - 3 (which would be -1, a start scheduled in the past).
    expect(armed.startWhen).toBeCloseTo(1.5, 6);
    expect(armed.startWhen).toBeCloseTo(endTime - 0.5, 6);
    expect(armed.startWhen).toBeGreaterThanOrEqual(0);
  });

  it("degrades to a gap when the incoming source cannot be sample-accurate", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(0.5, { transition: "crossfade" });
    const mixedTracks = [tracks[0]!, { ...tracks[1]!, source: "element" as const }];

    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    (globalThis as { Audio?: unknown }).Audio = function (): MockMediaElement {
      const element = new MockMediaElement();
      setTimeout(() => element.fireLoadedMetadata(120), 0);
      return element;
    } as unknown as typeof Audio;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ready = whenReady(engine);
      engine.setQueue(mixedTracks);
      await ready;
      await engine.play();
      await flush(); // would-be arm attempt for track B

      // Track B streams, so it cannot be scheduled to a sample: nothing gets armed for the
      // crossfade, even though the current track (A) is perfectly capable of one.
      expect(ctx.sources.length).toBe(1); // only track A's buffer source
      expect(ctx.mediaSources.length).toBe(1); // track B was loaded, then discarded unarmed

      const changed = nextTrackChange(engine);
      ctx.sources[0]!.fireEnded();
      expect(await changed).toMatchObject({ index: 1, transition: "gap" });
      expect(engine.lastTransition).toBe("gap");
    } finally {
      (globalThis as { Audio?: unknown }).Audio = originalAudio;
      warnSpy.mockRestore();
    }
  });

  it("reports lastTransition as crossfade after a completed crossfade boundary", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const changed = vi.fn();
    engine.on("trackchange", changed);
    await engine.play();
    await flush();

    ctx.sources[0]!.fireEnded(); // the outgoing source finishes; the armed one is promoted
    expect(engine.lastTransition).toBe("crossfade");
    expect(changed).toHaveBeenCalledWith({ index: 1, track: tracks[1], transition: "crossfade" });
  });
});
