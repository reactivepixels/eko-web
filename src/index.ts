export type {
  EkoTrack,
  EkoState,
  EkoWebEngineOptions,
  EkoEventMap,
  EkoEventName,
  EkoEventListener,
  TransitionKind,
} from "./types";

export type { EkoSnapshot } from "./engine/snapshot";

// Loudness utilities are part of the public surface, useful for offline analysis or
// precomputing ReplayGain-style track gains.
export {
  measureLoudnessLufs,
  samplePeak,
  computeNormalizationGain,
  dbToLinear,
  linearToDb,
} from "./engine/loudness";

export { EkoWebEngine } from "./engine/eko-web-engine";

export { EkoError } from "./engine/errors";
export type { EkoErrorCode, EkoErrorOptions } from "./engine/errors";

// The concrete strategy classes (BufferSourceStrategy, ElementSourceStrategy) are not
// exported: there is no `strategy` option to plug one into yet, so publishing the classes
// would be a public constructor nobody can use for anything. The types stay public because
// the interface itself, not a specific implementation of it, is what "WebCodecs can be
// added later without an API break" (see the design doc) depends on.
export type {
  SourceKind,
  LoadOptions,
  LoadedSource,
  AudioSourceStrategy,
} from "./engine/sources/source";

export { EkoQueue } from "./queue/queue";
export type { RepeatMode } from "./queue/queue";
