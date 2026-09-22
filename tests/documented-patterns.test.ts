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
 * and browsers cap those at around six per page.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, useState, useEffect } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { EkoWebEngine } from "../src/engine/eko-web-engine";
import { useEkoPlayer, useEkoTime } from "../src/react/index";
import { MockAudioContext, makeToneBuffer } from "./mock-audio";

afterEach(cleanup);

const makeEngine = () => {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = makeToneBuffer(0.5);
  return new EkoWebEngine({ context: ctx as unknown as AudioContext });
};

describe("the documented React pattern", () => {
  it("creates exactly one engine however many times the component renders", async () => {
    const created: EkoWebEngine[] = [];

    function Player() {
      // THE DOCUMENTED SHAPE: a lazy initializer, so the factory runs once for the life of
      // the component rather than on every render.
      const [engine] = useState(() => {
        const e = makeEngine();
        created.push(e);
        return e;
      });
      useEffect(() => () => engine.destroy(), [engine]);

      const player = useEkoPlayer(engine);
      const [, force] = useState(0);
      return createElement(
        "button",
        { onClick: () => force((n) => n + 1) },
        player.paused ? "Play" : "Pause",
      );
    }

    const { getByRole } = render(createElement(Player));
    const button = getByRole("button");
    for (let i = 0; i < 5; i++) await act(async () => button.click());

    expect(created).toHaveLength(1);
  });

  it("destroys the engine on unmount, so a mounted and unmounted tree leaves nothing behind", async () => {
    let engine: EkoWebEngine | null = null;

    function Player() {
      const [e] = useState(() => makeEngine());
      engine = e;
      useEffect(() => () => e.destroy(), [e]);
      useEkoPlayer(e);
      useEkoTime(e);
      return null;
    }

    const { unmount } = render(createElement(Player));
    const subscribers = () => (engine as unknown as { subscribers: Set<unknown> }).subscribers.size;
    expect(subscribers()).toBe(1);

    unmount();

    expect(subscribers()).toBe(0);
    // A destroyed engine refuses further use rather than failing quietly later. play() is
    // async, so it rejects rather than throwing where it was called.
    await expect(engine!.play()).rejects.toThrow();
  });

  it("keeps the transport callbacks stable, so a memoized child is not defeated", async () => {
    const seen: unknown[] = [];

    function Player() {
      const [engine] = useState(() => makeEngine());
      useEffect(() => () => engine.destroy(), [engine]);
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
