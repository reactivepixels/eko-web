import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EkoWebEngine } from "../engine/eko-web-engine";
import type { EkoSnapshot } from "../engine/snapshot";
import type { RepeatMode } from "../queue/queue";
import type { EkoTrack, EkoWebEngineOptions } from "../types";
import { captureCarry, engineKey, restoreCarry, type EngineCarry } from "../bindings/rebuild";

/** What `useEkoWebEngine` loads into the engine it builds, once, when it first mounts. */
export interface EkoWebEngineInit {
  /** The tracks to queue. Ignored after the first mount: call `engine.setQueue()` for that. */
  queue?: EkoTrack[];
  /** Where in `queue` to start. Default: the first track. */
  startIndex?: number;
}

/**
 * Create an {@link EkoWebEngine} that belongs to this component: built once, destroyed on
 * unmount, and rebuilt when an option that can only be set at construction changes.
 *
 * ```tsx
 * const engine = useEkoWebEngine({ transition: "gapless" }, { queue: TRACKS });
 * const player = useEkoPlayer(engine);
 * ```
 *
 * Three things this does that a hand-written `useState` + `useEffect` pair gets wrong:
 *
 * - **StrictMode.** In development React mounts, unmounts and remounts every component.
 *   Destroying the engine in that simulated unmount would leave the component holding a
 *   dead engine, because `useState` hands the same instance back. So teardown is deferred
 *   by one microtask and cancelled if the same engine mounts again before it runs, which
 *   is exactly what the simulated remount does. A real unmount still destroys it.
 * - **Construction-time options.** `transition`, `crossfadeSeconds`, `normalize`,
 *   `targetLufs`, `fadeSeconds`, `source`, `bufferMaxBytes` and `context` are read once, by
 *   the constructor. Changing one here builds a new engine and carries over the queue, the
 *   position in it, shuffle, repeat, volume and mute. Playback stops at that point: the new
 *   engine loads the same track, paused at its start. Inserts (`setInserts`) are not
 *   carried, because their nodes belong to the old engine's `AudioContext`. Options are
 *   compared by value, so an inline object literal does not rebuild on every render.
 * - **The initial queue.** `init.queue` is loaded in an effect, not during render, so a
 *   server render never starts a fetch, and a render React throws away never leaves an
 *   engine loading audio nobody owns.
 *
 * `shuffle` and `repeat` in `options` are starting values only. After mount, change them
 * with `player.setShuffle()` / `player.setRepeat()`.
 *
 * The returned engine's identity changes on a rebuild, so anything that listens to it
 * directly (`engine.on(...)` in an effect) should list `engine` in its dependencies, the
 * same as it would for any other prop.
 */
export function useEkoWebEngine(
  options: EkoWebEngineOptions = {},
  init: EkoWebEngineInit = {},
): EkoWebEngine {
  const key = engineKey(options);
  const context = options.context;
  // The constructor only assigns fields (no AudioContext until first play), so building
  // one during render is safe on the server, and the throwaway a StrictMode double render
  // makes holds nothing that needs releasing.
  const [engine, setEngine] = useState(() => new EkoWebEngine(options));
  const built = useRef({ engine, key, context });
  const initial = useRef(init);
  const queued = useRef(false);
  const pendingDestroy = useRef(new Set<EkoWebEngine>());
  const destroyed = useRef(new WeakSet<EkoWebEngine>());
  const carry = useRef<EngineCarry | null>(null);

  useEffect(() => {
    pendingDestroy.current.delete(engine);
    if (destroyed.current.has(engine)) {
      // Torn down while this component stayed alive: an <Activity> that hid it and is now
      // showing it again. Build a replacement from what the old one was doing.
      const next = new EkoWebEngine(options);
      if (carry.current) restoreCarry(next, carry.current);
      built.current = { engine: next, key, context };
      setEngine(next);
      return;
    }
    if (!queued.current) {
      queued.current = true;
      const { queue, startIndex } = initial.current;
      if (queue && queue.length > 0) engine.setQueue(queue, startIndex);
    }
    return () => {
      pendingDestroy.current.add(engine);
      queueMicrotask(() => {
        if (!pendingDestroy.current.delete(engine)) return;
        carry.current = captureCarry(engine);
        destroyed.current.add(engine);
        engine.destroy();
      });
    };
    // `options` is deliberately left out: it only matters when an engine is built, and the
    // rebuild effect below owns every case where it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  useEffect(() => {
    const current = built.current;
    if (current.key === key && current.context === context) return;
    const next = new EkoWebEngine(options);
    restoreCarry(next, captureCarry(current.engine));
    built.current = { engine: next, key, context };
    // The effect above destroys the old engine once this one has mounted in its place.
    setEngine(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, context]);

  return engine;
}

/**
 * The engine's current snapshot plus the transport it exposes, as one object.
 *
 * Referentially stable when nothing in the engine changed: a consumer can hand `player`
 * to a memoized child's props, or put it in a `useEffect` dependency array, without that
 * triggering on every render. Task 2 adds `useEkoTime` alongside this hook for the one
 * field deliberately left off {@link EkoSnapshot} (`currentTime`, which changes every
 * animation frame and would defeat that stability if it lived here).
 */
export interface EkoPlayer extends EkoSnapshot {
  play(): Promise<void>;
  pause(): void;
  next(): void;
  previous(): void;
  skipTo(index: number): void;
  seek(time: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  setVolume(v: number): void;
  setMuted(muted: boolean): void;
}

/**
 * `engine.subscribe`, `engine.getSnapshot`, and every transport method are ordinary
 * prototype methods on {@link EkoWebEngine}, not bound instance properties (the engine
 * stays framework-free, so it has no reason to bind them for a hook it doesn't know
 * about). Handing one to `useSyncExternalStore`, or to a consumer's memoized child,
 * unbound would lose `this` the moment something other than `engine.foo()` calls it back.
 *
 * Bound once per engine, here, so:
 * - `subscribe`/`getSnapshot` keep their `this` when `useSyncExternalStore` calls them.
 * - Every bound method's identity is stable across renders (this `useMemo` only
 *   recomputes when `engine` itself changes), so `useSyncExternalStore` does not
 *   resubscribe every render, and a consumer's memoized child does not re-render just
 *   because its callback prop looks new.
 */
function useBoundEngine(engine: EkoWebEngine) {
  return useMemo(
    () => ({
      subscribe: engine.subscribe.bind(engine),
      getSnapshot: engine.getSnapshot.bind(engine),
      play: engine.play.bind(engine),
      pause: engine.pause.bind(engine),
      next: engine.next.bind(engine),
      previous: engine.previous.bind(engine),
      skipTo: engine.skipTo.bind(engine),
      seek: engine.seek.bind(engine),
      setShuffle: engine.setShuffle.bind(engine),
      setRepeat: engine.setRepeat.bind(engine),
      setVolume: engine.setVolume.bind(engine),
      setMuted: engine.setMuted.bind(engine),
    }),
    [engine],
  );
}

/**
 * Subscribe a component to an {@link EkoWebEngine}'s discrete state (not `currentTime`;
 * see `useEkoTime`, task 2). Returns one object combining the current snapshot with the
 * engine's transport, referentially stable while nothing changes.
 *
 * The third `useSyncExternalStore` argument (the server snapshot) is `engine.getSnapshot`
 * again, which is what makes this safe to render during SSR with no mount-effect guard:
 * the engine's own snapshot is already a stable, pre-playback value before any
 * `AudioContext` exists.
 */
export function useEkoPlayer(engine: EkoWebEngine): EkoPlayer {
  const bound = useBoundEngine(engine);
  const snapshot = useSyncExternalStore(bound.subscribe, bound.getSnapshot, bound.getSnapshot);

  return useMemo(
    () => ({
      ...snapshot,
      play: bound.play,
      pause: bound.pause,
      next: bound.next,
      previous: bound.previous,
      skipTo: bound.skipTo,
      seek: bound.seek,
      setShuffle: bound.setShuffle,
      setRepeat: bound.setRepeat,
      setVolume: bound.setVolume,
      setMuted: bound.setMuted,
    }),
    [snapshot, bound],
  );
}

/** `useEkoTime`'s return value: just the two fields that change every frame. */
export interface EkoTime {
  readonly currentTime: number;
  readonly duration: number;
}

function readTime(engine: EkoWebEngine): EkoTime {
  return { currentTime: engine.currentTime, duration: engine.duration };
}

/**
 * Subscribe a component to an {@link EkoWebEngine}'s `currentTime`, on its own hook. See
 * the module doc on {@link EkoPlayer} for why: `currentTime` changes every animation
 * frame, and `useEkoPlayer`'s snapshot deliberately excludes it so that scrubbing a
 * progress bar re-renders the progress bar, not everything else reading `useEkoPlayer`.
 *
 * Runs no loop of its own. The engine already runs one (a private implementation detail,
 * not part of this contract) and emits a `timeupdate` event from every place `currentTime`
 * can change: once per frame while playing, immediately after `seek()` (including while
 * paused), and at the natural end (carrying the final position). Between those three sites
 * every change is covered, so a second, hook-owned loop would only do the same work twice.
 * This hook seeds its initial value directly from the engine (the lazy `useState`
 * initializer below), since nothing has fired yet at mount, the one case the event does
 * not cover, then just listens.
 */
export function useEkoTime(engine: EkoWebEngine): EkoTime {
  const [time, setTime] = useState<EkoTime>(() => readTime(engine));

  useEffect(() => {
    // Reseed on every engine, not just the first. The lazy initializer above runs once for
    // the life of the component, so a consumer swapping the engine it passes in (an
    // ordinary thing for a component that takes it as a prop) would otherwise keep showing
    // the old engine's last position until the new one emits, which never happens if the
    // new engine is paused.
    setTime(readTime(engine));
    const offTime = engine.on("timeupdate", ({ currentTime, duration }) =>
      setTime({ currentTime, duration }),
    );
    // `timeupdate` only fires while something is playing, after a seek, and at the end.
    // A track that has loaded and is sitting idle announces itself with `durationchange`
    // alone, so without this a progress bar has no scale and a track's length cannot be
    // shown until the listener presses play.
    const offDuration = engine.on("durationchange", ({ duration }) =>
      setTime((previous) => ({ currentTime: previous.currentTime, duration })),
    );
    return () => {
      offTime();
      offDuration();
    };
  }, [engine]);

  return time;
}
