import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { attachMediaSession } from "../src/media-session/index";
import type { EkoEventListener, EkoEventName, EkoTrack } from "../src/types";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

/** Flush pending microtasks (lets an async engine operation, e.g. a manual skip's load,
 * settle before assertions run). Same helper as gapless.test.ts. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function whenReady(engine: EkoWebEngine): Promise<void> {
  return new Promise((res) => {
    const off = engine.on("canplay", () => {
      off();
      res();
    });
  });
}

function setupRealEngine(trackCount: number): {
  ctx: MockAudioContext;
  engine: EkoWebEngine;
  tracks: EkoTrack[];
} {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5); // 0.5-second tracks
  const engine = new EkoWebEngine({ context: ctx as unknown as AudioContext });
  const tracks: EkoTrack[] = Array.from({ length: trackCount }, (_, i) => ({
    id: String(i),
    src: `/t${i}.flac`,
  }));
  return { ctx, engine, tracks };
}

/**
 * A hand-rolled `navigator.mediaSession` double. It records what the module under test does
 * (registered handlers, metadata writes, playback state, position-state calls) and can be
 * told to reproduce the sharp edges real browsers have (see the task-7 controller
 * amendment): `setActionHandler` throwing for an unsupported action, and `setPositionState`
 * throwing on values it considers invalid. A stub only shows what it's built to show, so
 * this one is built to throw exactly where the amendment says real browsers do.
 */
class StubMediaSession {
  metadata: unknown = null;
  playbackState: string = "none";
  handlers = new Map<string, unknown>();
  positionStateCalls: Array<{ duration: number; position: number; playbackRate?: number }> = [];
  unsupportedActions = new Set<string>();

  setActionHandler(action: string, handler: unknown): void {
    if (handler !== null && this.unsupportedActions.has(action)) {
      throw new TypeError(`NotSupportedError: unsupported media session action '${action}'`);
    }
    this.handlers.set(action, handler);
  }

  setPositionState(state: { duration: number; position: number; playbackRate?: number }): void {
    if (!Number.isFinite(state.duration) || state.duration < 0) {
      throw new TypeError(
        "Failed to execute 'setPositionState': duration is not finite or negative",
      );
    }
    if (state.position > state.duration) {
      throw new TypeError(
        "Failed to execute 'setPositionState': position must not exceed duration",
      );
    }
    if (state.playbackRate !== undefined && state.playbackRate < 0) {
      throw new TypeError(
        "Failed to execute 'setPositionState': playbackRate must not be negative",
      );
    }
    this.positionStateCalls.push(state);
  }

  call(action: string, details: unknown = {}): void {
    const handler = this.handlers.get(action) as ((d: unknown) => void) | null | undefined;
    if (!handler) throw new Error(`no handler registered for '${action}'`);
    handler(details);
  }
}

/** A real `MediaMetadata`-shaped constructor. Node has no such global, so tests that need
 * one to exist install this; tests for the "constructor missing" case leave it absent. */
class FakeMediaMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: unknown;
  constructor(init: { title?: string; artist?: string; album?: string; artwork?: unknown } = {}) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
    this.artwork = init.artwork;
  }
}

/**
 * A minimal stand-in for `EkoWebEngine` used only for the tests about the module's own
 * wiring logic (action handlers, position-state guards, detach, no-mediaSession no-op),
 * where forcing the real engine into a particular state (a NaN duration, an exact
 * position) would mean standing up a whole element-strategy load. The two tests that are
 * actually about engine BEHAVIOUR (trackchange updating metadata, and the gapless
 * boundary case this module exists for) use the real `EkoWebEngine` + `MockAudioContext`
 * below, not this.
 */
class FakeEngine {
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  next = vi.fn();
  previous = vi.fn();
  seek = vi.fn();
  skipTo = vi.fn();
  private _duration = 0;
  private _currentTime = 0;
  private listeners = new Map<string, Set<(payload: unknown) => void>>();

  get duration(): number {
    return this._duration;
  }
  get currentTime(): number {
    return this._currentTime;
  }
  setDuration(d: number): void {
    this._duration = d;
  }
  setCurrentTime(t: number): void {
    this._currentTime = t;
  }

  on<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (payload: unknown) => void);
    return () => set!.delete(fn as (payload: unknown) => void);
  }
  off<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): void {
    this.listeners.get(event)?.delete(fn as (payload: unknown) => void);
  }
  emit(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
  }
  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
  getSnapshot(): { track: EkoTrack | null } {
    return { track: null };
  }
}

function asEngine(fake: FakeEngine): EkoWebEngine {
  return fake as unknown as EkoWebEngine;
}

let originalNavigatorDescriptor: PropertyDescriptor | undefined;
let originalMediaMetadata: unknown;

/**
 * Node 22+ defines a real (getter-only) `navigator` global, so a plain
 * `globalThis.navigator = ...` throws ("Cannot set property navigator ... which has only a
 * getter"). Every test that needs to change it goes through `defineProperty` instead, and
 * `afterEach` restores the exact original descriptor rather than just a value, so the
 * suite hands the real Node global back exactly as it found it.
 */
function setGlobalNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  originalMediaMetadata = (globalThis as Record<string, unknown>).MediaMetadata;
});

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  }
  (globalThis as Record<string, unknown>).MediaMetadata = originalMediaMetadata;
  vi.restoreAllMocks();
});

function installStubMediaSession(): StubMediaSession {
  const session = new StubMediaSession();
  setGlobalNavigator({ mediaSession: session });
  return session;
}

function installFakeMediaMetadata(): void {
  (globalThis as Record<string, unknown>).MediaMetadata = FakeMediaMetadata;
}

describe("attachMediaSession: action handlers", () => {
  it("registers play/pause/previoustrack/nexttrack and each drives the matching engine method", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    attachMediaSession(asEngine(engine));

    session.call("play");
    expect(engine.play).toHaveBeenCalledTimes(1);

    session.call("pause");
    expect(engine.pause).toHaveBeenCalledTimes(1);

    session.call("previoustrack");
    expect(engine.previous).toHaveBeenCalledTimes(1);

    session.call("nexttrack");
    expect(engine.next).toHaveBeenCalledTimes(1);
  });

  it("seekto drives engine.seek(details.seekTime)", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    attachMediaSession(asEngine(engine));
    session.call("seekto", { seekTime: 12.5 });

    expect(engine.seek).toHaveBeenCalledWith(12.5);
  });

  it("seekbackward/seekforward default to a 10s offset and clamp into [0, duration]", () => {
    const engine = new FakeEngine();
    engine.setDuration(30);
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    attachMediaSession(asEngine(engine));

    engine.setCurrentTime(5);
    session.call("seekbackward", {}); // no seekOffset -> default 10 -> 5 - 10 clamps to 0
    expect(engine.seek).toHaveBeenLastCalledWith(0);

    engine.setCurrentTime(25);
    session.call("seekforward", {}); // default 10 -> 25 + 10 clamps to 30 (duration)
    expect(engine.seek).toHaveBeenLastCalledWith(30);

    engine.setCurrentTime(10);
    session.call("seekbackward", { seekOffset: 3 });
    expect(engine.seek).toHaveBeenLastCalledWith(7);

    session.call("seekforward", { seekOffset: 1000 }); // way past duration -> clamp
    expect(engine.seek).toHaveBeenLastCalledWith(30);
  });

  it("one unsupported action does not stop the rest from registering (real browsers throw per-action)", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    // Simulate a browser (Safari-shaped) that does not implement seekto: setActionHandler
    // throws for it. A registration loop with one shared try/catch around the whole thing
    // would lose every handler registered after this one.
    session.unsupportedActions.add("seekto");

    attachMediaSession(asEngine(engine));

    expect(session.handlers.has("seekto")).toBe(false);
    // Registered after seekto in source order; still present, proving the loop continued.
    session.call("seekbackward", {});
    expect(engine.seek).toHaveBeenCalled();
    session.call("seekforward", {});
    session.call("nexttrack");
    expect(engine.next).toHaveBeenCalledTimes(1);
  });

  it("play handler attaches a rejection handler so a blocked-autoplay rejection is not left unhandled", async () => {
    // `void engine.play()` alone would NOT do this: `void` only discards the expression's
    // value, it does not attach a rejection handler. Proving that requires checking that
    // `.catch` (or an equivalent rejection handler) was actually invoked on the specific
    // promise the engine returned, not just that nothing threw synchronously and no
    // process-level event fired (that signal turned out to be too timing-dependent under
    // Vitest's worker environment to trust; a direct spy on the promise itself is not).
    const engine = new FakeEngine();
    const rejection = Promise.reject(new Error("autoplay blocked"));
    const catchSpy = vi.spyOn(rejection, "catch");
    engine.play = vi.fn(() => rejection);
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    attachMediaSession(asEngine(engine));
    expect(() => session.call("play")).not.toThrow();

    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(catchSpy).toHaveBeenCalledTimes(1);

    // However the assertions above land, make sure this test's own deliberately-rejected
    // promise is never reported as an unhandled rejection by the time the test ends.
    await rejection.catch(() => {});
  });
});

describe("attachMediaSession: metadata", () => {
  it("registers action handlers even when MediaMetadata is unavailable, and skips metadata instead of throwing", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    // Deliberately do NOT install FakeMediaMetadata: Node has no such global by default,
    // reproducing a real environment where navigator.mediaSession exists but the separate
    // MediaMetadata constructor does not.
    expect(typeof (globalThis as Record<string, unknown>).MediaMetadata).toBe("undefined");

    attachMediaSession(asEngine(engine), { metadata: () => ({ title: "whatever" }) });
    engine.emit("trackchange", { index: 0, track: { src: "/a.flac" }, transition: "gap" });

    expect(session.metadata).toBeNull(); // never touched
    session.call("nexttrack"); // transport controls: the more valuable half, per the amendment
    expect(engine.next).toHaveBeenCalledTimes(1);
  });
});

describe("attachMediaSession: setPositionState", () => {
  it("is throttled: several timeupdates inside the window produce a single call", () => {
    const engine = new FakeEngine();
    engine.setDuration(10);
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    const dateSpy = vi.spyOn(Date, "now");
    let now = 0;
    dateSpy.mockImplementation(() => now);

    attachMediaSession(asEngine(engine), { positionUpdateMs: 100 });

    now = 0;
    engine.emit("timeupdate", { currentTime: 1, duration: 10 });
    now = 10;
    engine.emit("timeupdate", { currentTime: 1.1, duration: 10 });
    now = 50;
    engine.emit("timeupdate", { currentTime: 1.5, duration: 10 });
    expect(session.positionStateCalls.length).toBe(1);
    expect(session.positionStateCalls[0]).toMatchObject({ duration: 10, position: 1 });

    now = 150; // past the 100ms window
    engine.emit("timeupdate", { currentTime: 2, duration: 10 });
    expect(session.positionStateCalls.length).toBe(2);
    expect(session.positionStateCalls[1]).toMatchObject({ duration: 10, position: 2 });
  });

  it("uses a 1000ms default window when positionUpdateMs is not given", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    const dateSpy = vi.spyOn(Date, "now");
    let now = 0;
    dateSpy.mockImplementation(() => now);

    attachMediaSession(asEngine(engine));

    now = 0;
    engine.emit("timeupdate", { currentTime: 1, duration: 10 });
    now = 900; // inside the default 1000ms window
    engine.emit("timeupdate", { currentTime: 1.9, duration: 10 });
    expect(session.positionStateCalls.length).toBe(1);

    now = 1100; // past it
    engine.emit("timeupdate", { currentTime: 2, duration: 10 });
    expect(session.positionStateCalls.length).toBe(2);
  });

  it("guards before calling: a NaN duration never even reaches setPositionState", () => {
    // Spying (not mocking) leaves the stub's own guard in place, which would ALSO turn a
    // bad call into "no entry in positionStateCalls" on its own. Asserting on the spy's
    // call count, rather than on positionStateCalls, is what actually proves this
    // module's own pre-call guard exists: without it, the call is still attempted (and
    // only then rejected by the stub's guard), so a positionStateCalls-only assertion
    // would pass even with this module's guard deleted entirely.
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    const spy = vi.spyOn(session, "setPositionState");

    attachMediaSession(asEngine(engine));
    expect(() => engine.emit("timeupdate", { currentTime: 0, duration: NaN })).not.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });

  it("guards before calling: a position past duration by a hair never even reaches setPositionState", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    const spy = vi.spyOn(session, "setPositionState");

    attachMediaSession(asEngine(engine));
    expect(() => engine.emit("timeupdate", { currentTime: 10.0001, duration: 10 })).not.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });

  it("never throws even if the stub's own guards miss a case setPositionState itself rejects", () => {
    // Belt-and-braces: even a value that slips past this module's own guards must not
    // escape as an uncaught throw, because the underlying call is still wrapped in a
    // try/catch of its own.
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    vi.spyOn(session, "setPositionState").mockImplementation(() => {
      throw new TypeError("simulated engine-level rejection");
    });

    attachMediaSession(asEngine(engine));
    expect(() => engine.emit("timeupdate", { currentTime: 1, duration: 10 })).not.toThrow();
  });
});

describe("attachMediaSession: playback state", () => {
  it("playbackState follows the engine's play and pause events", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    attachMediaSession(asEngine(engine));

    engine.emit("play", undefined);
    expect(session.playbackState).toBe("playing");

    engine.emit("pause", undefined);
    expect(session.playbackState).toBe("paused");
  });
});

describe("attachMediaSession: detach", () => {
  it("removes every action handler and event subscription it took out, and stops updating", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();

    const detach = attachMediaSession(asEngine(engine));
    expect(engine.listenerCount()).toBeGreaterThan(0);
    const setActionHandlerSpy = vi.spyOn(session, "setActionHandler");

    detach();

    expect(engine.listenerCount()).toBe(0);
    for (const action of [
      "play",
      "pause",
      "previoustrack",
      "nexttrack",
      "seekto",
      "seekbackward",
      "seekforward",
    ]) {
      expect(session.handlers.get(action)).toBeNull();
    }

    // Nothing further updates the session after detach.
    session.metadata = "sentinel" as unknown as null;
    session.playbackState = "sentinel" as unknown as "none";
    engine.emit("trackchange", { index: 1, track: { src: "/b.flac" }, transition: "gap" });
    engine.emit("play", undefined);
    engine.emit("timeupdate", { currentTime: 1, duration: 10 });
    expect(session.metadata).toBe("sentinel");
    expect(session.playbackState).toBe("sentinel");
    expect(session.positionStateCalls.length).toBe(0);

    setActionHandlerSpy.mockRestore();
  });

  it("detach() only clears the actions that actually registered, never one that threw on registration", () => {
    const engine = new FakeEngine();
    const session = installStubMediaSession();
    installFakeMediaMetadata();
    session.unsupportedActions.add("seekto");

    const detach = attachMediaSession(asEngine(engine));
    const setActionHandlerSpy = vi.spyOn(session, "setActionHandler");

    detach();

    const clearedActions = setActionHandlerSpy.mock.calls.map((call) => call[0]);
    expect(clearedActions).not.toContain("seekto");
    expect(clearedActions).toContain("nexttrack");
  });
});

describe("attachMediaSession: no navigator.mediaSession", () => {
  it("importing the module does not throw in an environment with no navigator.mediaSession", async () => {
    setGlobalNavigator(undefined);
    vi.resetModules();
    await expect(import("../src/media-session/index")).resolves.toBeDefined();
  });

  it("attachMediaSession is a no-op returning a working detach when navigator.mediaSession is absent", async () => {
    setGlobalNavigator(undefined);
    vi.resetModules();
    const mod = await import("../src/media-session/index");
    const engine = new FakeEngine();

    const detach = mod.attachMediaSession(asEngine(engine));

    expect(typeof detach).toBe("function");
    expect(engine.listenerCount()).toBe(0); // never subscribed to anything
    expect(() => detach()).not.toThrow();
  });

  it("is also a no-op when navigator exists but has no mediaSession property", () => {
    setGlobalNavigator({});
    const engine = new FakeEngine();

    const detach = attachMediaSession(asEngine(engine));

    expect(engine.listenerCount()).toBe(0);
    expect(() => detach()).not.toThrow();
  });
});

describe("attachMediaSession: trackchange updates metadata (real engine)", () => {
  it("updates navigator.mediaSession.metadata when the engine emits trackchange from a manual skip", async () => {
    const restore = stubFetch();
    try {
      const { engine, tracks } = setupRealEngine(2);
      const ready = whenReady(engine);
      engine.setQueue(tracks);
      await ready;
      const session = installStubMediaSession();
      installFakeMediaMetadata();

      attachMediaSession(engine, {
        metadata: (track) => ({ title: `Track ${track.id}` }),
      });

      await engine.play();
      await flush();
      engine.next(); // manual skip: emits trackchange with the new track once its load lands
      await flush();

      expect((session.metadata as FakeMediaMetadata).title).toBe("Track 1");
    } finally {
      restore();
    }
  });

  /**
   * The case this subpath exists for. A gapless promotion (the current source's natural
   * 'ended' firing while a next track is already armed) advances the track with NO `src`
   * swap and NO media element event: nothing but the engine's own `trackchange` event
   * says a new track is now playing. If this module updated metadata off some other path
   * (e.g. polling `currentIndex`, or piggybacking on `canplay`/`loadedmetadata`, which
   * carry no track object anyway), this is the boundary that would expose it: this test
   * must fail if the `trackchange` subscription is removed, not pass for an unrelated
   * reason.
   */
  it("updates metadata on a gapless boundary, which fires no src swap and no element event", async () => {
    const restore = stubFetch();
    try {
      const { ctx, engine, tracks } = setupRealEngine(2);
      const ready = whenReady(engine);
      engine.setQueue(tracks);
      await ready;
      const session = installStubMediaSession();
      installFakeMediaMetadata();

      attachMediaSession(engine, {
        metadata: (track) => ({ title: `Track ${track.id}` }),
      });

      await engine.play();
      await flush(); // arms track B

      expect((session.metadata as FakeMediaMetadata).title).toBe("Track 0");

      ctx.sources[0]!.fireEnded(); // track A's natural end -> seamless promote to B
      expect(engine.currentIndex).toBe(1);
      expect(engine.lastTransition).toBe("gapless");

      expect((session.metadata as FakeMediaMetadata).title).toBe("Track 1");
    } finally {
      restore();
    }
  });
});
