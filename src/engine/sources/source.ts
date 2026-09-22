import type { EkoTrack, NormalizeMode } from "../../types";

/** How a track's audio reaches the graph. */
export type SourceKind = "buffer" | "element";

export interface LoadOptions {
  /** Already resolved: the engine maps `true` to `"auto"` before this reaches a strategy. */
  normalize: NormalizeMode;
  targetLufs: number;
  /**
   * Called in place of a strategy's own `console.warn` when normalization was requested
   * but there is no way to honour it (the element path has no decoded buffer to measure,
   * and the track carries no `gainDb`). Supplying this lets a caller that loads many
   * tracks in sequence, such as the engine across a whole queue, dedupe the warning once
   * for all of them rather than once per `LoadedSource`/strategy instance. Optional: a
   * strategy that owns its own per-instance warning (see `ElementSourceStrategy`) falls
   * back to that when this is omitted.
   */
  onUnmeasurableLoudness?: () => void;
}

/**
 * A track that is loaded and ready to be scheduled.
 *
 * `start()` may be called more than once: pause, play and seek all restart the same track.
 * Implementations must therefore be restartable, which for the buffer strategy means
 * building a fresh AudioBufferSourceNode each time, since those are single-use.
 */
export interface LoadedSource {
  readonly kind: SourceKind;
  readonly track: EkoTrack;
  readonly duration: number;
  /**
   * How far into the track playable data currently extends, in seconds. For the buffer
   * strategy this is always `duration` (the whole file is already decoded); for the
   * element strategy it reflects the browser's live `buffered` TimeRanges and grows as
   * more of the file downloads. Read at any time; it is not an event.
   */
  readonly bufferedEnd: number;
  /** Linear normalization gain to apply (1 = none). */
  readonly normGain: number;
  /** Whether this source can be scheduled to a sample boundary. */
  readonly canGapless: boolean;
  /**
   * This source's own level, carrying its normalization gain and any fade envelope.
   * Null until `connect()` has been called.
   */
  readonly gain: GainNode | null;
  /**
   * Set the node this source plays into. Call exactly once per loaded source, before
   * `start()`. Unlike `start()`, this is not restartable: it creates the source's own
   * `gain` node on each call, so a second call would build a second gain and silently
   * orphan the first (still connected, never disposed) rather than reusing or replacing
   * it. If a source ever needs to move to a different destination, that is a new
   * `LoadedSource`, not a second `connect()` on this one.
   */
  connect(destination: AudioNode): void;
  /**
   * Begin playback. `when` is an AudioContext time, where 0 means immediately.
   * A source with `canGapless: false` cannot honour a future `when` and the engine must
   * not schedule one.
   */
  start(when: number, offset: number): void;
  /** Stop playback, optionally at a future AudioContext time. */
  stop(when?: number): void;
  /** Called when the source reaches its natural end. Never called for an explicit stop. */
  onEnded(fn: () => void): void;
  /**
   * Called when a `start()` that appeared to succeed synchronously turns out to have
   * failed asynchronously. Today only the element strategy can produce this: the browser
   * silently blocking an `HTMLMediaElement.play()` call that did not originate from its
   * own user gesture (notably iOS Safari), discovered only once that promise rejects.
   * Wire this unconditionally, the same way `onEnded()` is always wired regardless of
   * whether a given source can actually end on its own; strategies that cannot fail this
   * way simply never call it.
   */
  onStartError(fn: (error: unknown) => void): void;
  dispose(): void;
}

/**
 * How a track gets from a URL into the graph. The interface exists so long files can
 * stream instead of being decoded whole, and so a WebCodecs strategy can be added later
 * without an API break.
 */
export interface AudioSourceStrategy {
  readonly kind: SourceKind;
  readonly canGapless: boolean;
  load(track: EkoTrack, ctx: AudioContext, options: LoadOptions): Promise<LoadedSource>;
}
