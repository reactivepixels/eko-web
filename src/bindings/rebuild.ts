import type { EkoWebEngine } from "../engine/eko-web-engine";
import type { RepeatMode } from "../queue/queue";
import type { EkoTrack, EkoWebEngineOptions } from "../types";

/**
 * What the framework bindings' `useEkoWebEngine` carries from one engine to the next when a
 * construction-time option changes. Shared so React and Vue rebuild identically; not part
 * of the public API.
 */

/**
 * The options only the constructor reads, as one comparable string. Two option objects
 * with the same values give the same key, so an inline object literal passed on every
 * render does not look like a change. `context` is left out because an `AudioContext`
 * does not serialise: the bindings compare it by identity alongside this key.
 *
 * `shuffle` and `repeat` are left out on purpose. They can be changed on a live engine,
 * so they are starting values, not a reason to rebuild.
 */
export function engineKey(options: EkoWebEngineOptions): string {
  return JSON.stringify([
    options.normalize,
    options.targetLufs,
    options.transition,
    options.crossfadeSeconds,
    options.fadeSeconds,
    options.source,
    options.bufferMaxBytes,
  ]);
}

export interface EngineCarry {
  queue: readonly EkoTrack[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
}

export function captureCarry(engine: EkoWebEngine): EngineCarry {
  return {
    queue: engine.queue,
    index: engine.currentIndex,
    shuffle: engine.shuffle,
    repeat: engine.repeat,
    volume: engine.volume,
    muted: engine.muted,
  };
}

/** Apply a carry to a freshly built engine. Queue last, so it loads under the carried
 * shuffle and repeat rather than the defaults. */
export function restoreCarry(engine: EkoWebEngine, carry: EngineCarry): void {
  engine.setShuffle(carry.shuffle);
  engine.setRepeat(carry.repeat);
  engine.setVolume(carry.volume);
  engine.setMuted(carry.muted);
  if (carry.queue.length > 0) {
    engine.setQueue([...carry.queue], carry.index >= 0 ? carry.index : undefined);
  }
}
