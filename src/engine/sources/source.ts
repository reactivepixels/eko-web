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
  /** Linear normalization gain to apply (1 = none). */
  readonly normGain: number;
  /** Whether this source can be scheduled to a sample boundary. */
  readonly canGapless: boolean;
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
