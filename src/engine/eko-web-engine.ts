import { Emitter } from "./event-emitter";
import { measureLoudnessLufs, samplePeak, computeNormalizationGain, dbToLinear } from "./loudness";
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

const DEFAULTS = { normalize: true, targetLufs: -16, gapless: true };

/**
 * Web Audio playback engine: decode-to-buffer playback through a gain graph
 * (`rgGain → fadeGain → userGain → destination`) with ReplayGain-style loudness
 * normalization. Phase 2: single track. Gapless queueing lands in Phase 3.
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
  private rgGain: GainNode | null = null;
  private fadeGain: GainNode | null = null;
  private userGain: GainNode | null = null;

  private queue: EkoTrack[] = [];
  private index = -1;
  private decoded: DecodedTrack | null = null;
  private source: AudioBufferSourceNode | null = null;

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
    this.queue = tracks.slice();
    this.index = tracks.length > 0 ? 0 : -1;
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
      this.emitter.emit("error", { error: error as Error });
    }
  }

  private async decodeTrack(track: EkoTrack): Promise<DecodedTrack> {
    const ctx = this.ensureGraph();
    const res = await fetch(track.src);
    if (!res.ok) throw new Error(`eko-web: fetch failed for ${track.src} (${res.status})`);
    const arr = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);
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
    if (ctx.state === "suspended") await ctx.resume();
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
  }

  pause(): void {
    if (this._paused) return;
    const t = this.currentTime; // capture before stopping the source
    this.stopSource();
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
      this.startSource(t);
    }
    this.emitter.emit("timeupdate", { currentTime: t, duration: this.decoded.duration });
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.userGain && !this._muted) this.userGain.gain.value = this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.userGain) this.userGain.gain.value = muted ? 0 : this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  destroy(): void {
    this.stopSource();
    this.stopRaf();
    this.emitter.clear();
    if (this.ctx && !this.injectedContext) void this.ctx.close();
    this.ctx = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  private ensureGraph(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = this.injectedContext ?? createAudioContext();
    this.ctx = ctx;
    this.rgGain = ctx.createGain();
    this.fadeGain = ctx.createGain();
    this.userGain = ctx.createGain();
    this.rgGain.connect(this.fadeGain);
    this.fadeGain.connect(this.userGain);
    this.userGain.connect(ctx.destination);
    this.userGain.gain.value = this._muted ? 0 : this._volume;
    return ctx;
  }

  private startSource(offset: number): void {
    const ctx = this.ctx!;
    const decoded = this.decoded!;
    const source = ctx.createBufferSource();
    source.buffer = decoded.buffer;
    this.rgGain!.gain.value = decoded.normGain;
    source.connect(this.rgGain!);
    this.endedByStop = false;
    source.onended = () => {
      if (!this.endedByStop) this.handleNaturalEnd();
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

  private handleNaturalEnd(): void {
    // Phase 3 hooks gapless next-track scheduling in here. Phase 2: end the playback.
    this.stopRaf();
    this._paused = true;
    this.source = null;
    this.startOffset = this.decoded?.duration ?? 0;
    this.setState("ended");
    this.emitter.emit("timeupdate", { currentTime: this.duration, duration: this.duration });
    this.emitter.emit("ended");
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
  if (!Ctor) throw new Error("eko-web: Web Audio API is unavailable in this environment");
  return new Ctor();
}
