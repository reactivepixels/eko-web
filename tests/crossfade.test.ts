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

  it("clamps the overlap to the incoming track's own duration, not just the outgoing one's remaining time", async () => {
    restore = stubFetch();
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5, 5); // track A: 5 seconds
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "crossfade",
      crossfadeSeconds: 3,
      // The two tracks are different lengths here, so they measure marginally different
      // loudness. Normalization is another test's subject; turning it off keeps both sides
      // at unity so the envelope below is about the overlap and nothing else.
      normalize: false,
    });
    const ready = whenReady(engine);
    engine.setQueue([
      { id: "a", src: "/a.flac" },
      { id: "b", src: "/b.flac" },
    ]);
    await ready;
    ctx.nextBuffer = makeToneBuffer(0.5, 2); // track B: shorter than the configured overlap
    const normGain = engine.normGain;
    await engine.play();
    await flush();

    const endTime = trackEndTime(0, 5, 0);
    const armed = ctx.sources[1]!;
    // A 3 second overlap would have B end a second before A did, and the promotion at B's
    // end hard-stops A partway down its own ramp. Two seconds is the most B can cover.
    expect(armed.startWhen).toBeCloseTo(endTime - 2, 6);

    // Both sides still ramp across the whole (now shorter) overlap.
    const [outgoing, incoming] = sourceGains(ctx);
    expect(outgoing!.gain.valueAt(endTime - 2)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(endTime)).toBeCloseTo(0, 6);
    expect(incoming!.gain.valueAt(endTime - 2)).toBeCloseTo(0, 6);
    expect(incoming!.gain.valueAt(endTime)).toBeCloseTo(normGain, 6);
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

  it("pause then resume mid-crossfade leaves the outgoing gain at its own normGain, not mid-ramp", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const normGain = engine.normGain;
    await engine.play();
    await flush(); // arms B; schedules A's own gain ramp from normGain@2 down to 0@3

    const [outgoing] = sourceGains(ctx);

    ctx.currentTime = 2.5; // partway through the overlap: the ramp is mid-flight
    engine.pause();
    // A paused track should hold its own steady level, not whatever the in-flight ramp
    // left behind (roughly half of normGain at this point, without the fix).
    expect(outgoing!.gain.valueAt(2.5)).toBeCloseTo(normGain, 6);

    void engine.play(); // resume: reuses the SAME current, and its SAME gain node
    // Resuming only restarts the playback node; it never touches the per-source gain
    // (that is fadeGain's job, a different node). The pin from pause() must still hold.
    expect(outgoing!.gain.valueAt(2.5)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(3)).toBeCloseTo(normGain, 6); // the old ramp's target is gone
  });

  it("restores the outgoing gain when a skip mid-crossfade fails and the same track plays on", async () => {
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5, 3);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "crossfade",
      crossfadeSeconds: 1,
    });
    const tracks = [
      { id: "a", src: "/a.flac", source: "buffer" as const },
      { id: "b", src: "/b.flac", source: "buffer" as const },
    ];

    let fetchOk = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: fetchOk,
        status: fetchOk ? 200 : 404,
        headers: { get: (): string | null => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      }) as unknown as Response) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };

    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const normGain = engine.normGain;
    await engine.play();
    await flush(); // arms B, which ramps A's own gain from normGain@2 down to 0@3

    const [outgoing] = sourceGains(ctx);
    ctx.currentTime = 2.5; // mid-overlap: A is halfway down its ramp

    // The next track has gone unreachable. The skip's own load fails, the queue rolls back,
    // and the engine resumes the track that never stopped being loaded: A.
    fetchOk = false;
    engine.next();
    await flush();

    expect(engine.state).toBe("playing");
    expect(engine.currentIndex).toBe(0);
    // A is audible again, so its own gain has to be back at its steady level. Left alone,
    // the crossfade ramp is still on the node and A plays out through silence, forever.
    expect(outgoing!.gain.valueAt(2.5)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(4)).toBeCloseTo(normGain, 6);
  });

  it("restores the outgoing gain when a setQueue mid-crossfade fails to load its own first track", async () => {
    const ctx = new MockAudioContext();
    ctx.nextBuffer = makeToneBuffer(0.5, 3);
    const engine = new EkoWebEngine({
      context: ctx as unknown as AudioContext,
      transition: "crossfade",
      crossfadeSeconds: 1,
    });
    const tracks = [
      { id: "a", src: "/a.flac", source: "buffer" as const },
      { id: "b", src: "/b.flac", source: "buffer" as const },
    ];

    let fetchOk = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: fetchOk,
        status: fetchOk ? 200 : 404,
        headers: { get: (): string | null => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      }) as unknown as Response) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };

    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const normGain = engine.normGain;
    await engine.play();
    await flush();

    const [outgoing] = sourceGains(ctx);
    ctx.currentTime = 2.5;

    // A new queue whose own first track cannot be fetched: loadIndex's catch path leaves
    // `current` exactly where it was, so A is still the loaded, restartable track.
    fetchOk = false;
    engine.setQueue([{ id: "c", src: "/c.flac", source: "buffer" as const }]);
    await flush();

    expect(engine.state).toBe("error");
    expect(outgoing!.gain.valueAt(2.5)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(4)).toBeCloseTo(normGain, 6);
  });

  it("stops an armed source on the pause fade's last sample rather than cutting it mid-overlap", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    await engine.play();
    await flush();

    const armedSource = ctx.sources[1]!;
    const armedGain = sourceGains(ctx)[1]!;
    ctx.currentTime = 2.5; // mid-overlap: the armed track is already audible
    engine.pause();

    // The shared fade only reaches silence at 2.51, so cutting the armed node now is the
    // raw discontinuity the fade was scheduled to cover.
    expect(armedSource.stopWhen).toBeCloseTo(2.51, 6);
    // Its own gain has to stay wired up until then too: disconnecting it is the same cut.
    expect(armedGain.connections.length).toBeGreaterThan(0);
  });

  it("lets the outgoing gain keep fading through a pause fade instead of stepping back to full", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, {
      transition: "crossfade",
      crossfadeSeconds: 1,
      // Long enough that the pause fade outlives the crossfade ramp, which is what makes
      // the pin's timing audible at all.
      fadeSeconds: 0.5,
    });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const normGain = engine.normGain;
    await engine.play();
    await flush(); // arms B: A's gain ramps normGain@2 down to 0@3

    const [outgoing] = sourceGains(ctx);
    ctx.currentTime = 2.9;
    engine.pause(); // the pause fade runs 2.9 to 3.4, so 3.0 falls inside it

    // A tenth of A's level is left at 2.95 and the listener can still hear it, so pinning
    // there would step it back to full in the middle of the fade.
    expect(outgoing!.gain.valueAt(2.95)).toBeCloseTo(normGain * 0.05, 6);
    expect(outgoing!.gain.valueAt(3)).toBeCloseTo(0, 6);
    // Only once the fade has finished, and the source with it, does the pin land.
    expect(outgoing!.gain.valueAt(3.4)).toBeCloseTo(normGain, 6);
  });

  it("seeking mid-crossfade leaves the outgoing gain at its own normGain after the restart", async () => {
    restore = stubFetch();
    const { ctx, engine, tracks } = setup(3, { transition: "crossfade", crossfadeSeconds: 1 });
    const ready = whenReady(engine);
    engine.setQueue(tracks);
    await ready;
    const normGain = engine.normGain;
    await engine.play();
    await flush(); // arms B; schedules A's own gain ramp from normGain@2 down to 0@3

    const [outgoing] = sourceGains(ctx);

    ctx.currentTime = 2.5; // partway through the overlap: the ramp is mid-flight
    engine.seek(1); // seeks backward, restarting the SAME current track through the SAME gain

    expect(outgoing!.gain.valueAt(2.5)).toBeCloseTo(normGain, 6);
    expect(outgoing!.gain.valueAt(3)).toBeCloseTo(normGain, 6); // the old ramp's target is gone
  });
});
