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

// Loudness utilities are part of the public surface — useful for offline analysis or
// precomputing ReplayGain-style track gains.
export {
  measureLoudnessLufs,
  samplePeak,
  computeNormalizationGain,
  dbToLinear,
  linearToDb,
} from "./engine/loudness";

// EkoWebEngine is exported once the engine lands (Phase 2).
export { EkoWebEngine } from "./engine/eko-web-engine";

export { EkoError } from "./engine/errors";
export type { EkoErrorCode, EkoErrorOptions } from "./engine/errors";

export type {
  SourceKind,
  LoadOptions,
  LoadedSource,
  AudioSourceStrategy,
} from "./engine/sources/source";
export { BufferSourceStrategy } from "./engine/sources/buffer-source";
export { ElementSourceStrategy } from "./engine/sources/element-source";
