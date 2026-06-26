export type {
  EkoTrack,
  EkoState,
  EkoWebEngineOptions,
  EkoEventMap,
  EkoEventName,
  EkoEventListener,
} from "./types";

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
