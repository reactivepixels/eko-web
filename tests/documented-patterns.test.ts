// @vitest-environment jsdom
/**
 * The patterns the documentation tells people to copy.
 *
 * Docs rot silently: a snippet can stop being correct and nothing fails. These tests hold
 * the documented shapes to the same standard as the library, so if the recommended way to
 * own an engine stops working, the suite says so rather than a stranger's app.
 *
 * The specific thing under test is engine ownership, which is the part a fragment cannot
 * show and the part people get wrong: an engine must be created ONCE and destroyed on
 * unmount. Creating one in a render body gives a fresh AudioContext on every state change,
 * and browsers cap those at around six per page. The docs hand that job to
 * `useEkoWebEngine`, so these tests render exactly that shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement, useState, StrictMode } from "react";
import { render, cleanup, act } from "@testing-library/react";
import type { EkoWebEngine } from "../src/engine/eko-web-engine";
import { useEkoPlayer, useEkoTime, useEkoWebEngine } from "../src/react/index";
import { MockAudioContext, makeToneBuffer, stubFetch } from "./mock-audio";

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restoreFetch?.();
  restoreFetch = null;
});

const makeCtx = () => {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  return ctx as unknown as AudioContext;
};

const TRACKS = [
  { id: "1", src: "/audio/01.mp3" },
  { id: "2", src: "/audio/02.mp3" },
];

/** Let the deferred teardown and any queued load settle, inside act(). */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("the documented React pattern", () => {
  it("creates exactly one engine however many times the component renders", async () => {
    restoreFetch = stubFetch();
    const ctx = makeCtx();
    const seen = new Set<EkoWebEngine>();

    function Player() {
      // THE DOCUMENTED SHAPE. (The docs pass no `context`; the test injects a mock one.)
      const engine = useEkoWebEngine({ context: ctx }, { queue: TRACKS });
      seen.add(engine);

      const player = useEkoPlayer(engine);
      const [, force] = useState(0);
      return createElement(
        "button",
        { onClick: () => force((n) => n + 1) },
        player.paused ? "Play" : "Pause",
      );
    }

    // StrictMode, because that is what a new Next.js or Vite app renders under, and it is
    // the case that used to leave a hand-rolled engine destroyed while still in use.
    const { getByRole } = render(createElement(StrictMode, null, createElement(Player)));
    await settle();
    const button = getByRole("button");
    for (let i = 0; i < 5; i++) await act(async () => button.click());

    expect(seen.size).toBe(1);
    const [engine] = seen;
    expect(engine!.getSnapshot().queueLength).toBe(2);
  });

  it("destroys the engine on unmount, so a mounted and unmounted tree leaves nothing behind", async () => {
    restoreFetch = stubFetch();
    const ctx = makeCtx();
    let engine: EkoWebEngine | null = null;

    function Player() {
      const e = useEkoWebEngine({ context: ctx }, { queue: TRACKS });
      engine = e;
      useEkoPlayer(e);
      useEkoTime(e);
      return null;
    }

    const { unmount } = render(createElement(Player));
    await settle();
    const subscribers = () => (engine as unknown as { subscribers: Set<unknown> }).subscribers.size;
    expect(subscribers()).toBe(1);

    unmount();
    await settle();

    expect(subscribers()).toBe(0);
    // A destroyed engine refuses further use rather than failing quietly later. play() is
    // async, so it rejects rather than throwing where it was called.
    await expect(engine!.play()).rejects.toThrow();
  });

  it("keeps the transport callbacks stable, so a memoized child is not defeated", async () => {
    const ctx = makeCtx();
    const seen: unknown[] = [];

    function Player() {
      const engine = useEkoWebEngine({ context: ctx });
      const { play } = useEkoPlayer(engine);
      seen.push(play);
      const [, force] = useState(0);
      return createElement("button", { onClick: () => force((n) => n + 1) }, "x");
    }

    const { getByRole } = render(createElement(Player));
    for (let i = 0; i < 3; i++) await act(async () => getByRole("button").click());

    expect(new Set(seen).size).toBe(1);
  });
});
