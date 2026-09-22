/**
 * `@rpxl/eko-web/media-session`: wires `navigator.mediaSession` (the OS lock screen and
 * hardware media keys) to an `EkoWebEngine`.
 *
 * Why this exists rather than being left to consumers: a gapless promotion changes track
 * with no `src` swap and no media element event. Anyone wiring `navigator.mediaSession` by
 * hand keys off element events, so their handler never fires and the lock screen shows the
 * wrong song for the rest of the queue. Subscribing to the engine's own `trackchange`
 * event, below, is what fixes that.
 *
 * This module deliberately does no file parsing: `MediaSessionOptions.metadata` is a
 * consumer-supplied callback because `EkoTrack` carries no title/artist/artwork of its own.
 *
 * `sideEffects: false` (see package.json): nothing here runs at import time. `navigator`
 * and `navigator.mediaSession` are only ever read from inside `attachMediaSession`, through
 * a function rather than a module-scope reference, so importing this module in an
 * environment with no `navigator` at all (an older browser, a non-browser runtime, this
 * project's own Node test suite) can never throw, and `attachMediaSession` itself degrades
 * to a no-op instead of crashing.
 */
import type { EkoWebEngine } from "../engine/eko-web-engine";
import type { EkoTrack } from "../types";

export interface MediaSessionOptions {
  /** Consumer-supplied: this library does not parse files, so it has no title/artist/
   * artwork of its own to offer. Return `undefined`/omit a field to leave it unset. */
  metadata?: (track: EkoTrack) => {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: Array<{ src: string; sizes?: string; type?: string }>;
  };
  /** How often `setPositionState` is allowed to fire, in ms. Default: `1000`. */
  positionUpdateMs?: number;
}

const DEFAULT_POSITION_UPDATE_MS = 1000;
/** Per the Media Session spec, `seekbackward`/`seekforward` carry an optional
 * `seekOffset`; this is the fallback when it is absent. */
const DEFAULT_SEEK_OFFSET_SECONDS = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `navigator.mediaSession`, read defensively: `navigator` itself may not exist as a global
 * at all (this is what makes importing this module, and calling `attachMediaSession`, safe
 * in Node and in older browsers alike). Read through a function, never a module-scope
 * reference, so the absence cannot throw a ReferenceError merely from evaluating this file.
 */
function getMediaSession(): MediaSession | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
}

/**
 * Wires the OS lock screen / hardware media keys to `engine`. Returns `detach()`, which
 * removes every action handler and event subscription this call took out; call it when
 * whatever attached is torn down.
 *
 * A no-op (with a working, harmless `detach`) when `navigator.mediaSession` is
 * unavailable.
 */
export function attachMediaSession(
  engine: EkoWebEngine,
  options: MediaSessionOptions = {},
): () => void {
  const found = getMediaSession();
  if (!found) {
    return () => {};
  }
  // Re-bound to a variable TS can see is never undefined from here on: the nested
  // `function` declarations below (setAction, updateMetadata) don't inherit the narrowing
  // from the check above, since a hoisted function declaration could in principle be
  // invoked at a point control-flow analysis can't see through.
  const mediaSession: MediaSession = found;

  const positionUpdateMs = options.positionUpdateMs ?? DEFAULT_POSITION_UPDATE_MS;
  const registeredActions: MediaSessionAction[] = [];
  const unsubscribers: Array<() => void> = [];
  let lastPositionUpdateAt = -Infinity;

  /**
   * Browsers implement different subsets of the action set; one that does not recognize
   * `action` throws (`NotSupportedError`, a `TypeError` in some versions). Every
   * registration gets its own try/catch so one unsupported action never takes the rest
   * down with it, and only actions that actually registered are tracked, so `detach()`
   * clears exactly those and nothing else.
   */
  function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler): void {
    try {
      mediaSession.setActionHandler(action, handler);
      registeredActions.push(action);
    } catch {
      // Not supported here; leave it unregistered and move on to the rest.
    }
  }

  setAction("play", () => {
    // engine.play() is async and rejects if the browser blocks it outside a user gesture.
    // The engine already emits its own 'error' event for that; this handler must not
    // invent a second report, only make sure the rejection is not left unhandled (`void`
    // alone would NOT do that: it discards the return value but attaches no handler).
    engine.play().catch(() => {});
  });
  setAction("pause", () => engine.pause());
  setAction("previoustrack", () => engine.previous());
  setAction("nexttrack", () => engine.next());
  setAction("seekto", (details) => {
    if (typeof details.seekTime === "number") engine.seek(details.seekTime);
  });
  setAction("seekbackward", (details) => {
    const offset = details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS;
    engine.seek(clamp(engine.currentTime - offset, 0, engine.duration));
  });
  setAction("seekforward", (details) => {
    const offset = details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS;
    engine.seek(clamp(engine.currentTime + offset, 0, engine.duration));
  });

  function updateMetadata(track: EkoTrack | null): void {
    if (!track) return;
    // `navigator.mediaSession` and the `MediaMetadata` constructor are separate features:
    // feature-detect it too. If it's missing, skip metadata rather than lose the transport
    // controls registered above over an unrelated constructor; those are the more valuable
    // half.
    if (typeof MediaMetadata === "undefined") return;
    const meta = options.metadata?.(track) ?? {};
    mediaSession.metadata = new MediaMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      artwork: meta.artwork,
    });
  }

  // Attach can happen mid-playback (wiring this up after setQueue()/play() already ran),
  // so seed metadata from whatever is already current rather than waiting for the next
  // boundary.
  updateMetadata(engine.getSnapshot().track);

  // The subscription this module exists for: a gapless promotion changes track with no
  // `src` swap and no media-element event, so `trackchange` is the only signal that fires
  // for it. Without this, the lock screen keeps showing the track that was current when
  // the queue started, for as long as gapless boundaries keep happening.
  unsubscribers.push(engine.on("trackchange", (payload) => updateMetadata(payload.track)));
  unsubscribers.push(
    engine.on("play", () => {
      mediaSession.playbackState = "playing";
    }),
  );
  unsubscribers.push(
    engine.on("pause", () => {
      mediaSession.playbackState = "paused";
    }),
  );
  unsubscribers.push(
    engine.on("timeupdate", ({ currentTime, duration }) => {
      const now = Date.now();
      if (now - lastPositionUpdateAt < positionUpdateMs) return;
      // setPositionState throws on a duration that is not finite and positive, and on a
      // position outside [0, duration]. Both are reachable here: an ElementSource's
      // duration is NaN until its metadata arrives, and `currentTime` is computed off the
      // audio clock rather than read from a media element, so it can land a hair past
      // `duration` right at a boundary. Skip the update rather than clamp: a clamped
      // position that is wrong is worse than no update at all.
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > duration) return;
      lastPositionUpdateAt = now;
      try {
        mediaSession.setPositionState({ duration, position: currentTime, playbackRate: 1 });
      } catch {
        // A browser can still reject values the guards above did not anticipate; this is
        // a lock-screen nicety, never worth crashing playback over.
      }
    }),
  );

  return function detach(): void {
    for (const action of registeredActions) {
      try {
        mediaSession.setActionHandler(action, null);
      } catch {
        // Clearing should never throw, but detach() must finish regardless.
      }
    }
    registeredActions.length = 0;
    for (const off of unsubscribers) off();
    unsubscribers.length = 0;
  };
}
