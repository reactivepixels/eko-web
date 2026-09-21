import type { EkoTrack } from "../../types";

/** How a track's audio reaches the graph. */
export type SourceKind = "buffer" | "element";

export interface LoadOptions {
  normalize: boolean;
  targetLufs: number;
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
  /** Set the node this source plays into. Call before `start()`. */
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
