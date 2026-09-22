import { useMemo, useSyncExternalStore } from "react";
import type { EkoWebEngine } from "../engine/eko-web-engine";
import type { EkoSnapshot } from "../engine/snapshot";
import type { RepeatMode } from "../queue/queue";

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
