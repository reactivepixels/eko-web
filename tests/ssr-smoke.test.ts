import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `package.json` declares `"sideEffects": false`, a promise to bundlers that importing any
 * of this package's entry points does no work on its own: no reading `window`, `document`
 * or `navigator`, no throwing, nothing but defining exports. A module that breaks that
 * promise quietly breaks every consumer's server render, because Node (or any other
 * non-browser SSR runtime) has none of those globals.
 *
 * This suite imports all four public entry points -- the core, the `<audio>`-element
 * adapter, `replaygain` and `media-session` -- in this project's own Node test environment
 * (vitest.config.ts: `environment: "node"`, so there is no jsdom here, no `window`, no
 * `document`) and exercises each one just enough to prove the promise: not only that the
 * import resolves, but that constructing an engine (and, for the two subpaths, calling
 * their real entry function) does not throw. An import that merely resolves proves nothing
 * about a lazy top-of-module global read gated behind a `typeof` check that this suite
 * defeats on purpose (see below) -- only actually driving the code proves that.
 *
 * `navigator` is force-removed before every test, not left to whatever this Node version
 * happens to define. Node 22+ ships a real, non-undefined `navigator` global (see
 * media-session.test.ts's own comment on this), so leaving it in place would let a
 * module-scope `navigator.mediaSession` read pass silently here (`navigator` exists, the
 * property is just `undefined`) while still throwing in an older browser or a stricter SSR
 * sandbox that has no `navigator` at all. Removing it turns that gap into a hard
 * `ReferenceError`/`TypeError` right here, which is the failure mode this test exists to
 * catch.
 */

let originalNavigatorDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  vi.resetModules();
});

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).navigator;
  }
});

describe("SSR smoke: no DOM present", () => {
  it("this environment has no window, no document, and (per beforeEach) no navigator", () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe("undefined");
    expect(typeof (globalThis as Record<string, unknown>).document).toBe("undefined");
    expect(typeof navigator).toBe("undefined");
  });

  it("importing the core entry point resolves and constructing an engine does not throw", async () => {
    const mod = await import("../src/index");
    expect(mod.EkoWebEngine).toBeDefined();
    let engine: InstanceType<typeof mod.EkoWebEngine> | undefined;
    expect(() => {
      engine = new mod.EkoWebEngine();
    }).not.toThrow();
    expect(engine?.state).toBe("idle");
  });

  it("importing the <audio>-element adapter resolves and constructing it does not throw", async () => {
    const mod = await import("../src/adapters/eko-audio-element");
    expect(mod.EkoAudioElement).toBeDefined();
    let el: InstanceType<typeof mod.EkoAudioElement> | undefined;
    expect(() => {
      el = new mod.EkoAudioElement();
    }).not.toThrow();
    expect(el?.paused).toBe(true);
    expect(el?.engine.state).toBe("idle");
  });

  it("importing the replaygain subpath resolves and readReplayGain does not throw", async () => {
    const mod = await import("../src/replaygain/index");
    expect(mod.readReplayGain).toBeDefined();
    await expect(mod.readReplayGain(new ArrayBuffer(8))).resolves.toBeDefined();
  });

  it("importing the media-session subpath resolves and attachMediaSession is a safe no-op with no navigator", async () => {
    const core = await import("../src/index");
    const mediaSession = await import("../src/media-session/index");
    expect(mediaSession.attachMediaSession).toBeDefined();

    const engine = new core.EkoWebEngine();
    let detach: (() => void) | undefined;
    expect(() => {
      detach = mediaSession.attachMediaSession(engine);
    }).not.toThrow();
    expect(typeof detach).toBe("function");
    expect(() => detach?.()).not.toThrow();
  });
});
