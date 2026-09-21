/**
 * Every failure the engine surfaces carries a machine-readable code, so consumers can
 * branch on the cause instead of matching on message text.
 */
export type EkoErrorCode =
  /** The Web Audio API is not available in this environment. */
  | "no_web_audio"
  /** A network or HTTP failure while fetching a track. */
  | "fetch_failed"
  /** `decodeAudioData` rejected the bytes it was given. */
  | "decode_failed"
  /** A container or codec the browser will not decode. */
  | "unsupported"
  /** `AudioContext.resume()` rejected, almost always because there was no user gesture. */
  | "autoplay_blocked"
  /** The next track could not be armed. Playback continues and the boundary degrades. */
  | "prefetch_failed";

export interface EkoErrorOptions {
  /** The original thrown value, kept for debugging. */
  cause?: unknown;
  /** Override the default for this code. */
  recoverable?: boolean;
}

/**
 * Codes that leave playback running. Everything else stops it, so `recoverable` defaults
 * to false and this set is the exception list.
 */
const RECOVERABLE: ReadonlySet<EkoErrorCode> = new Set<EkoErrorCode>(["prefetch_failed"]);

export class EkoError extends Error {
  readonly code: EkoErrorCode;
  /** True when playback continues despite this error. */
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(code: EkoErrorCode, message: string, options: EkoErrorOptions = {}) {
    super(message);
    this.name = "EkoError";
    this.code = code;
    this.cause = options.cause;
    this.recoverable = options.recoverable ?? RECOVERABLE.has(code);
  }
}
