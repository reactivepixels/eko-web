import type { EkoState, EkoTrack, TransitionKind } from "../types";
import type { SourceKind } from "./sources/source";
import type { RepeatMode } from "../queue/queue";

/**
 * The engine's discrete state, as one immutable object.
 *
 * This is what framework bindings subscribe to. `currentTime` is deliberately absent: it
 * changes every animation frame, so including it here would re-render a consumer's whole
 * tree at 60fps. It stays a getter on the engine, read through a separate hook.
 */
export interface EkoSnapshot {
  readonly state: EkoState;
  readonly paused: boolean;
  readonly index: number;
  readonly track: EkoTrack | null;
  readonly duration: number;
  readonly volume: number;
  readonly muted: boolean;
  /** What happened at the most recent boundary, or null before the first one. */
  readonly lastTransition: TransitionKind | null;
  /** How the current track is being played, or null when nothing is loaded. */
  readonly sourceKind: SourceKind | null;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
}

export const EMPTY_SNAPSHOT: EkoSnapshot = Object.freeze({
  state: "idle",
  paused: true,
  index: -1,
  track: null,
  duration: 0,
  volume: 1,
  muted: false,
  lastTransition: null,
  sourceKind: null,
  shuffle: false,
  repeat: "none",
});

/**
 * Field-by-field comparison. The engine keeps the previous object when this returns true,
 * because `useSyncExternalStore` loops forever on a snapshot whose identity keeps changing.
 */
export function snapshotsEqual(a: EkoSnapshot, b: EkoSnapshot): boolean {
  return (
    a.state === b.state &&
    a.paused === b.paused &&
    a.index === b.index &&
    a.track === b.track &&
    a.duration === b.duration &&
    a.volume === b.volume &&
    a.muted === b.muted &&
    a.lastTransition === b.lastTransition &&
    a.sourceKind === b.sourceKind &&
    a.shuffle === b.shuffle &&
    a.repeat === b.repeat
  );
}
