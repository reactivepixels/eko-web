// @vitest-environment jsdom
/**
 * `useEkoWebEngine`, in both bindings: the hook that owns an engine's lifecycle so a
 * consumer does not have to. The cases here are the ones a hand-written `useState` +
 * `useEffect(() => () => engine.destroy())` pair gets wrong: StrictMode's simulated
 * remount, a construction-time option changing, and an inline options literal that is a
 * new object on every render.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createElement, StrictMode, useState, Activity } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { createApp, defineComponent, effectScope, h, nextTick, reactive, ref } from "vue";
import * as reactBinding from "../src/react/index";
import * as vueBinding from "../src/vue/index";
import type { EkoWebEngine } from "../src/engine/eko-web-engine";
import type { EkoWebEngineOptions } from "../src/types";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

const TRACKS = [
  { id: "a", src: "/a.flac" },
  { id: "b", src: "/b.flac" },
  { id: "c", src: "/c.flac" },
];

function makeCtx(): AudioContext {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  return ctx as unknown as AudioContext;
}

/** TS `private` is compile-time only; this is the most direct read of whether destroy() ran. */
function isDestroyed(engine: EkoWebEngine): boolean {
  return (engine as unknown as { destroyed: boolean }).destroyed;
}

/**
 * Teardown is deferred by one microtask (see the hook's doc), and a queued track's load
 * settles over a few more (fetch, then decode). Wait out a macrotask inside act() so both
 * land before the next assertion, and so a late load cannot update React outside act().
 */
const flushMicrotasks = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let restoreFetch: () => void;
beforeEach(() => {
  restoreFetch = stubFetch();
});
afterEach(() => {
  cleanup();
  restoreFetch();
});

describe("React useEkoWebEngine", () => {
  function renderHookEngine(initialOptions: EkoWebEngineOptions, { strict = false } = {}) {
    const seen: EkoWebEngine[] = [];
    let setOptions!: (o: EkoWebEngineOptions) => void;
    let rerenderSame!: () => void;
    function Probe() {
      const [options, set] = useState(initialOptions);
      const [, force] = useState(0);
      setOptions = set;
      rerenderSame = () => force((n) => n + 1);
      // A fresh object literal every render, on purpose: that must not rebuild.
      const engine = reactBinding.useEkoWebEngine({ ...options }, { queue: TRACKS });
      reactBinding.useEkoPlayer(engine);
      seen.push(engine);
      return null;
    }
    const tree = strict
      ? createElement(StrictMode, null, createElement(Probe))
      : createElement(Probe);
    const result = render(tree);
    return {
      current: () => seen[seen.length - 1]!,
      seen,
      setOptions: (o: EkoWebEngineOptions) => act(async () => setOptions(o)),
      rerenderSame: () => act(async () => rerenderSame()),
      unmount: result.unmount,
    };
  }

  it("builds one engine, loads the initial queue after mount, and keeps it across re-renders", async () => {
    const ctx = makeCtx();
    const probe = renderHookEngine({ context: ctx });
    await flushMicrotasks();
    const engine = probe.current();
    expect(engine.getSnapshot().queueLength).toBe(3);

    for (let i = 0; i < 3; i++) await probe.rerenderSame();
    expect(new Set(probe.seen).size).toBe(1);
    expect(isDestroyed(engine)).toBe(false);
  });

  it("survives StrictMode's simulated unmount, and loads the queue exactly once", async () => {
    const ctx = makeCtx();
    const probe = renderHookEngine({ context: ctx }, { strict: true });
    await flushMicrotasks();
    const engine = probe.current();

    expect(isDestroyed(engine)).toBe(false);
    expect(engine.getSnapshot().queueLength).toBe(3);
    // A second setQueue in the remount would have reset a skip made in between; there is
    // none, so the proof is that the engine is alive and still usable.
    await act(async () => expect(() => engine.skipTo(2)).not.toThrow());
    expect(engine.currentIndex).toBe(2);
  });

  it("destroys the engine on a real unmount", async () => {
    const ctx = makeCtx();
    const probe = renderHookEngine({ context: ctx }, { strict: true });
    await flushMicrotasks();
    const engine = probe.current();

    probe.unmount();
    await flushMicrotasks();
    expect(isDestroyed(engine)).toBe(true);
  });

  it("rebuilds when a construction-time option changes, carrying queue, position and settings", async () => {
    const ctx = makeCtx();
    const probe = renderHookEngine({ context: ctx, transition: "gapless" });
    await flushMicrotasks();
    const first = probe.current();
    await act(async () => {
      first.skipTo(1);
      first.setVolume(0.4);
      first.setMuted(true);
      first.setRepeat("all");
      first.setShuffle(true);
    });

    await probe.setOptions({ context: ctx, transition: "crossfade", crossfadeSeconds: 2 });
    await flushMicrotasks();
    const second = probe.current();

    expect(second).not.toBe(first);
    expect(isDestroyed(first)).toBe(true);
    expect(isDestroyed(second)).toBe(false);
    expect(second.config.transition).toBe("crossfade");
    expect(second.config.crossfadeSeconds).toBe(2);
    expect(second.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(second.currentIndex).toBe(1);
    expect(second.volume).toBe(0.4);
    expect(second.muted).toBe(true);
    expect(second.repeat).toBe("all");
    expect(second.shuffle).toBe(true);
  });

  it("does not rebuild when only shuffle or repeat change in options (they are starting values)", async () => {
    const ctx = makeCtx();
    const probe = renderHookEngine({ context: ctx, shuffle: false });
    await flushMicrotasks();
    const first = probe.current();

    await probe.setOptions({ context: ctx, shuffle: true, repeat: "one" });
    await flushMicrotasks();
    expect(probe.current()).toBe(first);
    expect(isDestroyed(first)).toBe(false);
  });

  it("rebuilds when a different AudioContext is supplied", async () => {
    const probe = renderHookEngine({ context: makeCtx() });
    await flushMicrotasks();
    const first = probe.current();

    await probe.setOptions({ context: makeCtx() });
    await flushMicrotasks();
    expect(probe.current()).not.toBe(first);
    expect(isDestroyed(first)).toBe(true);
    expect(probe.current().queue).toHaveLength(3);
  });

  it("replaces an engine torn down by a hidden <Activity>, carrying what it was doing", async () => {
    const ctx = makeCtx();
    const seen: EkoWebEngine[] = [];
    function Probe() {
      const engine = reactBinding.useEkoWebEngine({ context: ctx }, { queue: TRACKS });
      seen.push(engine);
      return null;
    }
    const tree = (mode: "visible" | "hidden") =>
      createElement(Activity, { mode, children: createElement(Probe) });

    const { rerender } = render(tree("visible"));
    await flushMicrotasks();
    const first = seen[seen.length - 1]!;
    await act(async () => first.skipTo(2));

    await act(async () => rerender(tree("hidden")));
    await flushMicrotasks();
    expect(isDestroyed(first)).toBe(true);

    await act(async () => rerender(tree("visible")));
    await flushMicrotasks();
    const second = seen[seen.length - 1]!;
    expect(second).not.toBe(first);
    expect(isDestroyed(second)).toBe(false);
    expect(second.queue).toHaveLength(3);
    expect(second.currentIndex).toBe(2);
  });
});

describe("Vue useEkoWebEngine", () => {
  it("in an effectScope: loads the queue at once, and destroys the engine on stop", () => {
    const ctx = makeCtx();
    const scope = effectScope();
    const engine = scope.run(() =>
      vueBinding.useEkoWebEngine({ context: ctx }, { queue: TRACKS }),
    )!;
    const first = engine.value;
    expect(first.getSnapshot().queueLength).toBe(3);

    scope.stop();
    expect(isDestroyed(first)).toBe(true);
  });

  it("rebuilds when a construction-time option changes, carrying queue, position and settings", async () => {
    const ctx = makeCtx();
    const options = ref<EkoWebEngineOptions>({ context: ctx, transition: "gapless" });
    const scope = effectScope();
    const engine = scope.run(() => {
      const e = vueBinding.useEkoWebEngine(options, { queue: TRACKS });
      // The composables accept the returned ref as is.
      const player = vueBinding.useEkoPlayer(e);
      return { e, player };
    })!;
    const first = engine.e.value;
    first.skipTo(1);
    first.setVolume(0.4);
    first.setRepeat("all");

    options.value = { context: ctx, transition: "crossfade" };
    await nextTick();
    const second = engine.e.value;

    expect(second).not.toBe(first);
    expect(isDestroyed(first)).toBe(true);
    expect(second.config.transition).toBe("crossfade");
    expect(second.currentIndex).toBe(1);
    expect(second.volume).toBe(0.4);
    expect(second.repeat).toBe("all");
    expect(engine.player.value.queueLength).toBe(3);

    scope.stop();
    expect(isDestroyed(second)).toBe(true);
  });

  it("does not rebuild when a new options object carries the same values", async () => {
    const ctx = makeCtx();
    const options = reactive<EkoWebEngineOptions>({ context: ctx, transition: "gap" });
    const scope = effectScope();
    const engine = scope.run(() => vueBinding.useEkoWebEngine(() => ({ ...options })))!;
    const first = engine.value;

    options.shuffle = true; // a starting value, not a rebuild
    options.transition = "gap";
    await nextTick();
    expect(engine.value).toBe(first);
    scope.stop();
  });

  it("in a component: loads the queue on mount and destroys the engine on unmount", async () => {
    const ctx = makeCtx();
    let captured: EkoWebEngine | null = null;
    const Comp = defineComponent({
      setup() {
        const engine = vueBinding.useEkoWebEngine({ context: ctx }, { queue: TRACKS });
        captured = engine.value;
        expect(engine.value.getSnapshot().queueLength).toBe(0); // not before mount
        return () => h("div");
      },
    });
    const el = document.createElement("div");
    const app = createApp(Comp);
    app.mount(el);
    expect(captured!.getSnapshot().queueLength).toBe(3);

    app.unmount();
    expect(isDestroyed(captured!)).toBe(true);
  });
});
