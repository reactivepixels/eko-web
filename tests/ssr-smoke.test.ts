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
 *
 * M4 adds the `react` and `vue` subpaths to this suite. Both are Node-environment tests
 * (no jsdom): the React binding's own render-based tests live in `react.test.ts` under a
 * per-file jsdom environment directive, and this file must NOT adopt one, because jsdom
 * supplies a real `window`/`document`/`navigator` and would silently defeat the one thing
 * this suite exists to catch. The React case here only imports the module and
 * constructs an engine: React hooks can't run outside a render, and the binding's own
 * import is SSR-safe by construction (it only imports from `react`, itself SSR-safe, plus
 * types). The Vue case goes one step further and runs `useEkoPlayer`/`useEkoTime` inside a
 * bare `effectScope()`, because Vue composables need no render at all, and because
 * `onScopeDispose` is the one thing in the Vue binding worth specifically checking for a
 * console warning on a server render.
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

  it("importing the react binding entry resolves and constructing an engine does not throw", async () => {
    const mod = await import("../src/react/index");
    expect(mod.useEkoPlayer).toBeDefined();
    expect(mod.useEkoTime).toBeDefined();
    expect(mod.useEkoWebEngine).toBeDefined();

    const core = await import("../src/index");
    let engine: InstanceType<typeof core.EkoWebEngine> | undefined;
    expect(() => {
      engine = new core.EkoWebEngine();
    }).not.toThrow();
    expect(engine?.state).toBe("idle");
  });

  it("useEkoWebEngine server-renders in React without starting a fetch or creating an AudioContext", async () => {
    const react = await import("react");
    const { renderToString } = await import("react-dom/server");
    const mod = await import("../src/react/index");

    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      function Player() {
        const engine = mod.useEkoWebEngine({}, { queue: [{ id: "a", src: "/a.flac" }] });
        const { paused, queueLength } = mod.useEkoPlayer(engine);
        return react.createElement("span", null, `${paused ? "Play" : "Pause"} ${queueLength}`);
      }
      // The queue loads in an effect, which a server render never runs, so the markup
      // shows the engine as it is before anything loads.
      expect(renderToString(react.createElement(Player))).toContain("Play 0");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("useEkoWebEngine server-renders in Vue without starting a fetch", async () => {
    const vue = await import("vue");
    const { renderToString } = await import("vue/server-renderer");
    const mod = await import("../src/vue/index");

    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const Player = vue.defineComponent({
        setup() {
          const engine = mod.useEkoWebEngine({}, { queue: [{ id: "a", src: "/a.flac" }] });
          const player = mod.useEkoPlayer(engine);
          return () => vue.h("span", null, `queued ${player.value.queueLength}`);
        },
      });
      // Inside a component the queue loads in onMounted, which never runs on the server.
      expect(await renderToString(vue.createSSRApp(Player))).toContain("queued 0");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("importing the vue binding entry resolves, and its composables run inside a bare effectScope with no DOM and print no console warning", async () => {
    const mod = await import("../src/vue/index");
    const { effectScope } = await import("vue");
    const core = await import("../src/index");
    expect(mod.useEkoPlayer).toBeDefined();
    expect(mod.useEkoTime).toBeDefined();

    // `onScopeDispose` is safe outside a component but warns in some contexts; a warning on
    // every server render is its own kind of broken, so this fails the test if Vue emits one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const engine = new core.EkoWebEngine();
    const scope = effectScope();
    let player: ReturnType<typeof mod.useEkoPlayer> | undefined;
    let time: ReturnType<typeof mod.useEkoTime> | undefined;
    expect(() => {
      scope.run(() => {
        player = mod.useEkoPlayer(engine);
        time = mod.useEkoTime(engine);
      });
    }).not.toThrow();

    expect(player?.value.state).toBe("idle");
    expect(time?.currentTime.value).toBe(0);

    scope.stop();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
