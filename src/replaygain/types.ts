/**
 * Shared result shape for every ReplayGain tag format this subpath understands (Vorbis
 * comments, ID3v2, APEv2, MP4 freeform atoms). Defined exactly once here so every
 * parser and the public `index.ts` re-export all point at the same type: a second
 * declaration elsewhere would give consumers two structurally identical types that are
 * not the same type to anyone reading the `.d.ts`.
 */
export interface ReplayGainTags {
  gainDb?: number;
  peak?: number;
}
