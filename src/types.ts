import type { EkoError } from "./engine/errors";

/**
 * What actually happened at a track boundary.
 *
 * `"gapless"` means the next source was scheduled on the exact sample the previous one
 * ended. `"gap"` means it was not, either because the policy asked for a gap, because one
 * side of the boundary was a streaming source that cannot be scheduled, or because the
 * prefetch failed. The engine reports this rather than degrading silently.
 */
export type TransitionKind = "gapless" | "gap";

/** A track in the engine's queue. */
export interface EkoTrack {
  /** Stable id for the consumer (optional). */
  id?: string;
  /** Audio URL: anything the browser can `fetch()` + `decodeAudioData()`. */
  src: string;
  /**
   * Optional precomputed normalization gain in dB (e.g. a ReplayGain track-gain tag).
   * When omitted and `normalize` is on, the engine measures loudness from the decoded
   * buffer instead.
   */
  gainDb?: number;
  /**
   * Force a playback strategy for this track, overriding the engine's `source` option.
   * Use `"element"` for something long (a DJ set, a podcast) that must not be decoded
   * whole, at the cost of gapless on its boundaries.
   */
  source?: "buffer" | "element";
}

/** High-level engine state. */
export type EkoState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface EkoWebEngineOptions {
  /** Loudness-normalize tracks (ReplayGain-style). Default: `true`. */
  normalize?: boolean;
  /** Target integrated loudness (LUFS) for normalization. Default: `-16`. */
  targetLufs?: number;
  /** Boundary policy between queued tracks. Default: `"gapless"`. */
  transition?: TransitionKind;
  /**
   * Inject an AudioContext (a shared app context, or a mock in tests). When omitted, one is
   * created lazily on first `play()` (so it's tied to a user gesture per autoplay policy).
   */
  context?: AudioContext;
  /**
   * Seconds for the click-removal ramp on play, pause and seek. Default: `0.01`. Raise it
   * for an audible fade; do not set it to 0 unless you want clicks.
   */
  fadeSeconds?: number;
  /**
   * How tracks reach the graph. `"buffer"` decodes whole files, which is the only path
   * that can be gapless. `"element"` streams, which keeps memory flat at any length but
   * is never sample-accurate and cannot measure loudness. `"auto"` (the default) picks
   * per track using `bufferMaxBytes`, and it has a cost: it issues a HEAD request per
   * track before the GET, so a queue under `"auto"` pays two round trips per track. Set
   * `source: "buffer"` or `"element"` explicitly to skip that extra request when you
   * already know your content.
   */
  source?: "auto" | "buffer" | "element";
  /**
   * The `Content-Length` above which `source: "auto"` streams instead of decoding.
   * Default: 50 MB. This is a heuristic, because compressed size predicts decoded size
   * badly for lossy formats, and the two branches fail in different directions: an
   * oversized file falls back to streaming, so it loses sample-accuracy, while an
   * unknown size (a server that will not answer HEAD, or omits `Content-Length`) falls
   * back to buffering, so it gets no memory protection at all, on top of the wasted
   * HEAD. Set `source: "element"` explicitly for known-long content behind a server
   * like that.
   */
  bufferMaxBytes?: number;
}

/**
 * Event payloads. A `void` payload means the event carries no data, so listeners receive
 * `undefined` and you may `emit(name)` with no second argument.
 */
export interface EkoEventMap {
  loadstart: { index: number };
  loadedmetadata: { index: number; duration: number };
  durationchange: { duration: number };
  canplay: { index: number };
  play: void;
  pause: void;
  timeupdate: { currentTime: number; duration: number };
  ended: void;
  /** Fires AFTER a track boundary. The UI advances on this, not on a `src` swap. */
  trackchange: {
    index: number;
    track: EkoTrack;
    transition: TransitionKind;
  };
  volumechange: { volume: number; muted: boolean };
  error: {
    error: EkoError;
  };
}

export type EkoEventName = keyof EkoEventMap;
export type EkoEventListener<E extends EkoEventName> = (payload: EkoEventMap[E]) => void;
