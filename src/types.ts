import type { EkoError } from "./engine/errors";

/** A track in the engine's queue. */
export interface EkoTrack {
  /** Stable id for the consumer (optional). */
  id?: string;
  /** Audio URL — anything the browser can `fetch()` + `decodeAudioData()`. */
  src: string;
  /**
   * Optional precomputed normalization gain in dB (e.g. a ReplayGain track-gain tag).
   * When omitted and `normalize` is on, the engine measures loudness from the decoded
   * buffer instead.
   */
  gainDb?: number;
}

/** High-level engine state. */
export type EkoState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface EkoWebEngineOptions {
  /** Loudness-normalize tracks (ReplayGain-style). Default: `true`. */
  normalize?: boolean;
  /** Target integrated loudness (LUFS) for normalization. Default: `-16`. */
  targetLufs?: number;
  /** Gapless transitions between queued tracks. Default: `true`. */
  gapless?: boolean;
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
}

/**
 * Event payloads. A `void` payload means the event carries no data — listeners receive
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
  progress: { bufferedEnd: number };
  ended: void;
  /** Fires AFTER a seamless gapless transition — the UI advances on this, not on `src` swap. */
  trackchange: { index: number; track: EkoTrack };
  volumechange: { volume: number; muted: boolean };
  error: {
    error: EkoError;
  };
}

export type EkoEventName = keyof EkoEventMap;
export type EkoEventListener<E extends EkoEventName> = (payload: EkoEventMap[E]) => void;
