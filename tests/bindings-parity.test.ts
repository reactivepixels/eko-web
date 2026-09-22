// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { effectScope } from "vue";
import * as reactBinding from "../src/react/index";
import * as vueBinding from "../src/vue/index";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { MockAudioContext, makeToneBuffer } from "./mock-audio";

/**
 * M4 shipped two bindings (React and Vue) specifically to prove the core stays
 * framework-free: one binding alone can hide accidental coupling that only a second,
 * independent one would surface. That argument only holds while the two stay equivalent,
 * so this suite is the thing that keeps them from drifting apart.
 *
 * It does not care about the two bindings' input shapes (React's hooks take a plain
 * `EkoWebEngine`; Vue's composables take a `MaybeRefOrGetter<EkoWebEngine>`, a deliberate,
 * approved asymmetry: Vue's is each framework's own idiom, and a strict superset of
 * React's). It only compares NAMES and returned-object KEYS: what a consumer reading one
 * framework's docs would expect to find, unsurprised, in the other's.
 */

function makeEngine(): EkoWebEngine {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  return new EkoWebEngine({ context: ctx as unknown as AudioContext });
}

afterEach(() => {
  cleanup();
});

describe("React/Vue binding parity", () => {
  it("both bindings export exactly the same named exports", () => {
    // Settled: only these three hooks/composables are exposed. `EkoPlayer`/`EkoTime`/
    // `EkoWebEngineInit` are types, erased at compile time, and never show up here.
    const expected = ["useEkoPlayer", "useEkoTime", "useEkoWebEngine"];

    expect(Object.keys(reactBinding).sort()).toEqual(expected);
    expect(Object.keys(vueBinding).sort()).toEqual(expected);
  });

  it("useEkoPlayer's returned object carries the same keys in both bindings, given the same engine", () => {
    const engine = makeEngine();

    let reactPlayer: ReturnType<typeof reactBinding.useEkoPlayer> | undefined;
    function Probe() {
      reactPlayer = reactBinding.useEkoPlayer(engine);
      return null;
    }
    const { unmount } = render(createElement(Probe));

    const scope = effectScope();
    const vuePlayer = scope.run(() => vueBinding.useEkoPlayer(engine))!;

    expect(reactPlayer).toBeDefined();
    const reactKeys = Object.keys(reactPlayer!).sort();
    // React returns the snapshot fields and methods as plain values; Vue wraps the whole
    // object in a readonly ref. Compare KEYS, not values or the wrapper shape.
    const vueKeys = Object.keys(vuePlayer.value).sort();

    expect(vueKeys).toEqual(reactKeys);
    // Settled ruling: the whole snapshot (12 fields) plus all ten transport methods.
    expect(reactKeys).toHaveLength(22);
    expect(reactKeys).toEqual(
      [
        "state",
        "paused",
        "index",
        "queueLength",
        "track",
        "duration",
        "volume",
        "muted",
        "lastTransition",
        "sourceKind",
        "shuffle",
        "repeat",
        "play",
        "pause",
        "next",
        "previous",
        "skipTo",
        "seek",
        "setShuffle",
        "setRepeat",
        "setVolume",
        "setMuted",
      ].sort(),
    );

    unmount();
    scope.stop();
  });

  it("useEkoTime's returned object carries the same keys in both bindings", () => {
    const engine = makeEngine();

    let reactTime: ReturnType<typeof reactBinding.useEkoTime> | undefined;
    function Probe() {
      reactTime = reactBinding.useEkoTime(engine);
      return null;
    }
    const { unmount } = render(createElement(Probe));

    const scope = effectScope();
    const vueTime = scope.run(() => vueBinding.useEkoTime(engine))!;

    expect(reactTime).toBeDefined();
    const reactKeys = Object.keys(reactTime!).sort();
    // React returns plain numbers; Vue returns readonly refs. Compare keys, not values.
    const vueKeys = Object.keys(vueTime).sort();

    expect(vueKeys).toEqual(reactKeys);
    expect(reactKeys).toEqual(["currentTime", "duration"]);

    unmount();
    scope.stop();
  });
});
