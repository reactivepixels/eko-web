import {
  onScopeDispose,
  readonly,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { EkoWebEngine } from "../engine/eko-web-engine";
import type { EkoSnapshot } from "../engine/snapshot";
import type { RepeatMode } from "../queue/queue";

/**
 * The engine's current snapshot plus the transport it exposes, as one object. Mirrors
 * `EkoPlayer` from `src/react/index.ts`: same fields, same methods, Vue's own idiom
 * (a readonly ref) instead of React's plain value. See that file's module doc for why
 * `currentTime` is deliberately absent (it lives on `useEkoTime` instead).
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
 * prototype methods on {@link EkoWebEngine}, not bound instance properties (see the
 * matching note in `src/react/index.ts`: the engine stays framework-free, so it has no
 * reason to bind them for a binding it doesn't know about). Bound once per engine here,
 * so a consumer holding onto `player.value.play` keeps a callback that still has the
 * right `this` no matter how it's later invoked.
 */
function boundTransport(engine: EkoWebEngine) {
  return {
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
  };
}

function buildPlayer(
  engine: EkoWebEngine,
  transport: ReturnType<typeof boundTransport>,
): EkoPlayer {
  return { ...engine.getSnapshot(), ...transport };
}

/**
 * Subscribe to an {@link EkoWebEngine}'s discrete state (not `currentTime`; see
 * `useEkoTime`). Returns a `shallowRef` (Vue's idiom for "one opaque value that changes
 * as a whole", the same role `useSyncExternalStore` plays in the React binding) wrapped
 * in `readonly()`, so a consumer cannot assign over it and believe that mutated the
 * engine.
 *
 * `engine` may be a plain {@link EkoWebEngine}, a `Ref` to one, or a getter, exactly like
 * any VueUse-style composable. Passing a `Ref`/getter lets a consumer swap the engine
 * later (e.g. a `computed` picking a different player instance) without unmounting;
 * this hook re-seeds and re-subscribes to the new engine when that happens, the same
 * guarantee `useEkoTime` gives below.
 *
 * Works inside a bare `effectScope()` as well as inside a component: teardown runs via
 * `onScopeDispose`, which fires on `scope.stop()` and on component unmount alike.
 */
export function useEkoPlayer(engine: MaybeRefOrGetter<EkoWebEngine>): Readonly<Ref<EkoPlayer>> {
  const player = shallowRef<EkoPlayer>() as Ref<EkoPlayer>;

  const stopWatch = watch(
    () => toValue(engine),
    (current, _previous, onCleanup) => {
      const transport = boundTransport(current);
      const publish = () => {
        player.value = buildPlayer(current, transport);
      };
      publish();
      onCleanup(current.subscribe(publish));
    },
    { immediate: true },
  );

  onScopeDispose(stopWatch);

  return readonly(player);
}

/** `useEkoTime`'s return value: two independently-updating refs, per spec 8.2 ("separate
 * refs"), so a template reading only one of them doesn't re-render on the other. */
export interface EkoTime {
  readonly currentTime: Readonly<Ref<number>>;
  readonly duration: Readonly<Ref<number>>;
}

/**
 * Subscribe to an {@link EkoWebEngine}'s `currentTime`/`duration`, on their own composable.
 * See `useEkoPlayer`'s doc, and the module doc on `EkoPlayer` in `src/react/index.ts`, for
 * why: these change every animation frame, and `useEkoPlayer`'s snapshot deliberately
 * excludes them so that scrubbing a progress bar only re-renders the progress bar.
 *
 * Runs no loop of its own, exactly like the React hook. The engine already runs one (a
 * private implementation detail) and emits a `timeupdate` event from every place these
 * values can change: once per frame while playing, immediately after `seek()` (including
 * while paused), and at the natural end (carrying the final position). This composable
 * seeds its refs directly from the engine on setup (and again on every engine swap, the
 * one case nothing has fired yet), then just listens.
 *
 * `engine` accepts the same `MaybeRefOrGetter` shape as `useEkoPlayer`. Seeding only once,
 * on first setup, would leave a stale reading forever if a later engine is paused, since
 * it would never emit; this reseeds on every engine the source resolves to, not just the
 * first.
 */
export function useEkoTime(engine: MaybeRefOrGetter<EkoWebEngine>): EkoTime {
  const currentTime = ref(0);
  const duration = ref(0);

  const stopWatch = watch(
    () => toValue(engine),
    (current, _previous, onCleanup) => {
      currentTime.value = current.currentTime;
      duration.value = current.duration;
      const offTime = current.on("timeupdate", (payload) => {
        currentTime.value = payload.currentTime;
        duration.value = payload.duration;
      });
      // `timeupdate` only fires while something is playing, after a seek, and at the end.
      // A track that has loaded and is sitting idle announces itself with `durationchange`
      // alone, so without this a progress bar has no scale and a track's length cannot be
      // shown until the listener presses play.
      const offDuration = current.on("durationchange", (payload) => {
        duration.value = payload.duration;
      });
      onCleanup(() => {
        offTime();
        offDuration();
      });
    },
    { immediate: true },
  );

  onScopeDispose(stopWatch);

  return { currentTime: readonly(currentTime), duration: readonly(duration) };
}
