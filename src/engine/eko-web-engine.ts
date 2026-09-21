import { Emitter } from "./event-emitter";
import { EkoError, type EkoErrorCode } from "./errors";
import { EkoGraph } from "./graph";
import { measureLoudnessLufs, samplePeak, computeNormalizationGain, dbToLinear } from "./loudness";
import { trackEndTime } from "./scheduling";
import type {
  EkoTrack,
  EkoState,
  EkoWebEngineOptions,
  EkoEventName,
  EkoEventListener,
} from "../types";

interface DecodedTrack {
  track: EkoTrack;
  buffer: AudioBuffer;
  /** Linear normalization gain to apply (1 = none). */
  normGain: number;
  duration: number;
}

/** The next track, decoded and scheduled to start at exactly `startCtxTime` (gapless). */
interface ArmedTrack {
  decoded: DecodedTrack;
  source: AudioBufferSourceNode;
  index: number;
  startCtxTime: number;
}

const DEFAULTS = { normalize: true, targetLufs: -16, gapless: true };

/**
 * Web Audio playback engine: decode-to-buffer playback through a gain graph
 * (`rgGain → fadeGain → userGain → destination`) with ReplayGain-style loudness
 * normalization and true (sample-accurate) gapless track transitions.
 *
 * NOT bit-perfect — see the project README.
 */
export class EkoWebEngine {
  private emitter = new Emitter();
  private readonly normalize: boolean;
  private readonly targetLufs: number;
  private readonly gapless: boolean;
  private readonly injectedContext?: AudioContext;

  private ctx: AudioContext | null = null;
  private graph: EkoGraph | null = null;

  private queue: EkoTrack[] = [];
  private index = -1;
  private decoded: DecodedTrack | null = null;
  private source: AudioBufferSourceNode | null = null;
  private armed: ArmedTrack | null = null;

  private _state: EkoState = "idle";
  private _volume = 1;
  private _muted = false;
  private _paused = true;

  // Playback clock: the active source started at ctx time `startCtxTime`, from buffer
  // offset `startOffset` (seconds).
  private startCtxTime = 0;
  private startOffset = 0;
  private endedByStop = false;
  private playRequested = false;
  private rafHandle: number | null = null;

  constructor(options: EkoWebEngineOptions = {}) {
    this.normalize = options.normalize ?? DEFAULTS.normalize;
    this.targetLufs = options.targetLufs ?? DEFAULTS.targetLufs;
    this.gapless = options.gapless ?? DEFAULTS.gapless;
    this.injectedContext = options.context;
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  on<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): () => void {
    return this.emitter.on(event, fn);
  }
  off<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): void {
    this.emitter.off(event, fn);
  }

  // ── Read state ──────────────────────────────────────────────────────────────
  get state(): EkoState {
    return this._state;
  }
  get paused(): boolean {
    return this._paused;
  }
  get volume(): number {
    return this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }
  /** The engine's resolved options. */
  get config(): { normalize: boolean; targetLufs: number; gapless: boolean } {
    return { normalize: this.normalize, targetLufs: this.targetLufs, gapless: this.gapless };
  }
  get duration(): number {
    return this.decoded?.duration ?? 0;
  }
  get currentIndex(): number {
    return this.index;
  }
  get currentTime(): number {
    if (!this.decoded) return 0;
    if (this._paused || !this.ctx) return this.startOffset;
    const t = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
    return Math.max(0, Math.min(t, this.decoded.duration));
  }

  // ── Queue / load ────────────────────────────────────────────────────────────
  setQueue(tracks: EkoTrack[]): void {
    this.teardown();
    this.queue = tracks.slice();
    this.index = tracks.length > 0 ? 0 : -1;
    this._paused = true;
    if (this.index >= 0) void this.loadIndex(0);
  }

  load(srcOrTrack: string | EkoTrack): void {
    const track: EkoTrack = typeof srcOrTrack === "string" ? { src: srcOrTrack } : srcOrTrack;
    this.setQueue([track]);
  }

  private async loadIndex(index: number): Promise<void> {
    const track = this.queue[index];
    if (!track) return;
    this.setState("loading");
    this.emitter.emit("loadstart", { index });
    try {
      const decoded = await this.decodeTrack(track);
      this.decoded = decoded;
      this.index = index;
      this.startOffset = 0;
      this.setState("ready");
      this.emitter.emit("loadedmetadata", { index, duration: decoded.duration });
      this.emitter.emit("durationchange", { duration: decoded.duration });
      this.emitter.emit("canplay", { index });
      if (this.playRequested) {
        this.playRequested = false;
        void this.play();
      }
    } catch (error) {
      this.setState("error");
      this.emitter.emit("error", { error: asEkoError(error, "decode_failed") });
    }
  }

  private async decodeTrack(track: EkoTrack): Promise<DecodedTrack> {
    const ctx = this.ensureGraph();

    let arr: ArrayBuffer;
    try {
      const res = await fetch(track.src);
      if (!res.ok) {
        throw new EkoError(
          "fetch_failed",
          `eko-web: fetch failed for ${track.src} (${res.status})`,
        );
      }
      arr = await res.arrayBuffer();
    } catch (cause) {
      if (cause instanceof EkoError) throw cause;
      throw new EkoError("fetch_failed", `eko-web: fetch failed for ${track.src}`, { cause });
    }

    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(arr);
    } catch (cause) {
      throw new EkoError("decode_failed", `eko-web: could not decode ${track.src}`, { cause });
    }

    return {
      track,
      buffer,
      normGain: this.computeNormGain(track, buffer),
      duration: buffer.duration,
    };
  }

  private computeNormGain(track: EkoTrack, buffer: AudioBuffer): number {
    if (!this.normalize) return 1;
    const channels = channelsOf(buffer);
    const peak = samplePeak(channels);
    // Prefer an embedded/precomputed gain; else measure loudness from the decoded buffer.
    if (typeof track.gainDb === "number") {
      const g = dbToLinear(track.gainDb);
      return peak > 0 ? Math.min(g, 1 / peak) : g;
    }
    const lufs = measureLoudnessLufs(channels, buffer.sampleRate);
    return computeNormalizationGain(lufs, this.targetLufs, peak);
  }

  // ── Transport ───────────────────────────────────────────────────────────────
  async play(): Promise<void> {
    const ctx = this.ensureGraph();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (cause) {
        // Do not reject: the engine calls `void this.play()` internally, and a rejection
        // there would surface as an unhandled rejection in the consumer's app.
        this.emitter.emit("error", {
          error: new EkoError(
            "autoplay_blocked",
            "eko-web: the browser blocked playback. Call play() from a user gesture.",
            { cause },
          ),
        });
        return;
      }
    }
    if (!this.decoded) {
      // Play as soon as the current track finishes decoding.
      this.playRequested = true;
      return;
    }
    if (!this._paused) return;
    this.startSource(this.startOffset);
    this._paused = false;
    this.setState("playing");
    this.emitter.emit("play");
    this.startRaf();
    void this.armNext();
  }

  pause(): void {
    if (this._paused) return;
    const t = this.currentTime; // capture before stopping the source
    this.stopSource();
    this.clearArmed();
    this.startOffset = t;
    this._paused = true;
    this.setState("paused");
    this.stopRaf();
    this.emitter.emit("pause");
  }

  seek(time: number): void {
    if (!this.decoded) return;
    const t = Math.max(0, Math.min(time, this.decoded.duration));
    if (this._paused) {
      this.startOffset = t;
    } else {
      this.stopSource();
      this.clearArmed();
      this.startSource(t);
      void this.armNext(); // re-arm from the new position
    }
    this.emitter.emit("timeupdate", { currentTime: t, duration: this.decoded.duration });
  }

  /** Skip to the next track (manual — a small decode gap is acceptable here). */
  next(): void {
    if (this.index + 1 < this.queue.length) void this.skipTo(this.index + 1);
  }

  /** Skip to the previous track. */
  previous(): void {
    if (this.index > 0) void this.skipTo(this.index - 1);
  }

  private async skipTo(index: number): Promise<void> {
    const wasPlaying = !this._paused;
    this.stopSource();
    this.clearArmed();
    this._paused = true;
    this.stopRaf();
    await this.loadIndex(index);
    const track = this.queue[index];
    if (track) this.emitter.emit("trackchange", { index, track });
    if (wasPlaying) void this.play();
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.graph && !this._muted) this.graph.userGain.gain.value = this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.graph) this.graph.userGain.gain.value = muted ? 0 : this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  /** The engine's AudioContext, so consumers can build nodes to insert. */
  get context(): AudioContext {
    return this.ensureGraph();
  }

  /**
   * An AnalyserNode on the output, for spectrum and waveform displays. Created on first
   * access. The library exposes the data, never a canvas.
   */
  get analyser(): AnalyserNode {
    this.ensureGraph();
    return this.graph!.analyser;
  }

  /**
   * Insert your own nodes (an EQ, a compressor) after normalization and before the fader.
   * Pass an empty array to remove them. Inserts survive track changes.
   */
  setInserts(nodes: AudioNode[]): void {
    this.ensureGraph();
    this.graph!.setInserts(nodes);
  }

  destroy(): void {
    this.teardown();
    this.emitter.clear();
    this.graph?.destroy();
    this.graph = null;
    if (this.ctx && !this.injectedContext) void this.ctx.close();
    this.ctx = null;
  }

  // ── Gapless internals ─────────────────────────────────────────────────────────
  /** Decode the next queued track and schedule it to start the instant this one ends. */
  private async armNext(): Promise<void> {
    if (!this.gapless || this._paused || !this.decoded || !this.ctx) return;
    const nextIndex = this.index + 1;
    if (nextIndex >= this.queue.length || this.armed) return;
    const track = this.queue[nextIndex];
    if (!track) return;

    // The boundary is fixed once the current source started (start time + offset).
    const endCtxTime = trackEndTime(this.startCtxTime, this.decoded.duration, this.startOffset);

    let next: DecodedTrack;
    try {
      next = await this.decodeTrack(track);
    } catch (cause) {
      // Recoverable: the current track keeps playing, the boundary degrades to a gap.
      this.emitter.emit("error", {
        error: new EkoError(
          "prefetch_failed",
          `eko-web: could not preload ${track.src}; this boundary will have a gap`,
          { cause },
        ),
      });
      return;
    }
    // Bail if playback moved on while we were decoding (pause / seek / skip / re-arm).
    if (this._paused || !this.ctx || this.index !== nextIndex - 1 || this.armed) return;

    const source = this.ctx.createBufferSource();
    source.buffer = next.buffer;
    source.connect(this.graph!.input);
    source.onended = (): void => {
      if (!this.endedByStop) this.handleSourceEnded();
    };
    source.start(endCtxTime, 0);
    // Jump the shared normalization gain to the next track's value exactly at the boundary.
    this.graph!.rgGain.gain.setValueAtTime(next.normGain, endCtxTime);
    this.armed = { decoded: next, source, index: nextIndex, startCtxTime: endCtxTime };
  }

  /** A source reached its natural end — promote the armed next track, or end the queue. */
  private handleSourceEnded(): void {
    if (this.armed) {
      const armed = this.armed;
      this.armed = null;
      this.decoded = armed.decoded;
      this.source = armed.source;
      this.index = armed.index;
      this.startCtxTime = armed.startCtxTime;
      this.startOffset = 0;
      this.emitter.emit("durationchange", { duration: armed.decoded.duration });
      this.emitter.emit("trackchange", { index: armed.index, track: armed.decoded.track });
      void this.armNext();
    } else {
      this.handleNaturalEnd();
    }
  }

  private clearArmed(): void {
    if (this.armed) {
      try {
        this.armed.source.stop();
      } catch {
        /* not started */
      }
      this.armed.source.disconnect();
      this.armed = null;
    }
    if (this.ctx && this.graph) {
      this.graph.rgGain.gain.cancelScheduledValues(this.ctx.currentTime);
      if (this.decoded) this.graph.rgGain.gain.value = this.decoded.normGain;
    }
  }

  private handleNaturalEnd(): void {
    this.stopRaf();
    this._paused = true;
    this.source = null;
    this.startOffset = this.decoded?.duration ?? 0;
    this.setState("ended");
    this.emitter.emit("timeupdate", { currentTime: this.duration, duration: this.duration });
    this.emitter.emit("ended");
  }

  // ── Source / graph internals ──────────────────────────────────────────────────
  private ensureGraph(): AudioContext {
    if (this.ctx && this.graph) return this.ctx;
    const ctx = this.injectedContext ?? createAudioContext();
    this.ctx = ctx;
    this.graph = new EkoGraph(ctx);
    this.graph.userGain.gain.value = this._muted ? 0 : this._volume;
    return ctx;
  }

  private startSource(offset: number): void {
    const ctx = this.ctx!;
    const decoded = this.decoded!;
    const source = ctx.createBufferSource();
    source.buffer = decoded.buffer;
    this.graph!.rgGain.gain.value = decoded.normGain;
    source.connect(this.graph!.input);
    this.endedByStop = false;
    source.onended = (): void => {
      if (!this.endedByStop) this.handleSourceEnded();
    };
    source.start(0, offset);
    this.source = source;
    this.startCtxTime = ctx.currentTime;
    this.startOffset = offset;
  }

  private stopSource(): void {
    if (!this.source) return;
    this.endedByStop = true;
    try {
      this.source.stop();
    } catch {
      /* already stopped */
    }
    this.source.disconnect();
    this.source = null;
  }

  /** Stop both the current and armed sources (used by pause/seek/skip/destroy). */
  private teardown(): void {
    this.stopSource();
    this.clearArmed();
    this.stopRaf();
  }

  private setState(s: EkoState): void {
    this._state = s;
  }

  private startRaf(): void {
    if (typeof requestAnimationFrame !== "function") return; // non-browser (tests)
    const tick = (): void => {
      if (this._paused) return;
      this.emitter.emit("timeupdate", { currentTime: this.currentTime, duration: this.duration });
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafHandle != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = null;
  }
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channels;
}

function createAudioContext(): AudioContext {
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new EkoError("no_web_audio", "eko-web: the Web Audio API is unavailable here");
  }
  return new Ctor();
}

/** Wrap an unknown thrown value as an EkoError, preserving one that is already coded. */
function asEkoError(value: unknown, fallback: EkoErrorCode): EkoError {
  if (value instanceof EkoError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new EkoError(fallback, message, { cause: value });
}
