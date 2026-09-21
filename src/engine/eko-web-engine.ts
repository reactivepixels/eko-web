import { Emitter } from "./event-emitter";
import { EkoError, type EkoErrorCode } from "./errors";
import { EkoGraph } from "./graph";
import { trackEndTime } from "./scheduling";
import { rampTo, DEFAULT_FADE_SECONDS } from "./fades";
import { selectStrategy } from "./sources/select";
import type { LoadedSource } from "./sources/source";
import { EMPTY_SNAPSHOT, snapshotsEqual, type EkoSnapshot } from "./snapshot";
import type {
  EkoTrack,
  EkoState,
  EkoWebEngineOptions,
  EkoEventName,
  EkoEventListener,
  TransitionKind,
} from "../types";

/** The next track, loaded and scheduled to start at exactly `startCtxTime` (gapless). */
interface ArmedTrack {
  loaded: LoadedSource;
  index: number;
  startCtxTime: number;
}

const DEFAULTS = {
  normalize: true,
  targetLufs: -16,
  gapless: true,
  transition: "gapless" as TransitionKind,
  fadeSeconds: DEFAULT_FADE_SECONDS,
  source: "auto" as const,
  bufferMaxBytes: 50 * 1024 * 1024,
};

/**
 * Web Audio playback engine: each track plays through a selectable source strategy
 * (decode to buffer, or stream via a media element) into a gain graph
 * (`rgGain → fadeGain → userGain → destination`) with ReplayGain-style loudness
 * normalization. Gapless (sample-accurate) transitions only happen between buffered
 * tracks; see `source` and `bufferMaxBytes` in `EkoWebEngineOptions`.
 *
 * NOT bit-perfect — see the project README.
 */
export class EkoWebEngine {
  private emitter = new Emitter();
  private readonly normalize: boolean;
  private readonly targetLufs: number;
  private readonly transition: TransitionKind;
  private _lastTransition: TransitionKind | null = null;
  private readonly fadeSeconds: number;
  private readonly sourcePreference: "auto" | "buffer" | "element";
  private readonly bufferMaxBytes: number;
  private readonly injectedContext?: AudioContext;

  private ctx: AudioContext | null = null;
  private graph: EkoGraph | null = null;

  private queue: EkoTrack[] = [];
  private index = -1;
  private current: LoadedSource | null = null;
  private armed: ArmedTrack | null = null;

  private _state: EkoState = "idle";
  private _volume = 1;
  private _muted = false;
  private _paused = true;

  private subscribers = new Set<() => void>();
  private snapshot: EkoSnapshot = EMPTY_SNAPSHOT;

  // Playback clock: the active source started at ctx time `startCtxTime`, from buffer
  // offset `startOffset` (seconds).
  private startCtxTime = 0;
  private startOffset = 0;
  private playRequested = false;
  // Set while a gap-advance (`advanceWithGap`) is loading the next track from a standing
  // start. During that window `_paused` is also forced true, so a consumer's own `pause()`
  // call cannot register through the normal "already paused" early return; this flag lets
  // it record intent anyway, so the advance does not resume playback against the consumer's
  // wishes once the load settles.
  private advancing = false;
  private pauseRequestedDuringAdvance = false;
  // Bumped by setQueue(), skipTo() and destroy(): the three calls that make an in-flight
  // loadIndex() stale. loadIndex(), skipTo() and advanceWithGap() capture the current token
  // when they start and check it again after their await, so a superseded load never assigns
  // state or emits events for a track the engine has already moved past.
  private advanceToken = 0;
  private rafHandle: number | null = null;

  constructor(options: EkoWebEngineOptions = {}) {
    this.normalize = options.normalize ?? DEFAULTS.normalize;
    this.targetLufs = options.targetLufs ?? DEFAULTS.targetLufs;
    // `gapless: false` is the older spelling of `transition: "gap"`.
    this.transition =
      options.transition ?? (options.gapless === false ? "gap" : DEFAULTS.transition);
    this.fadeSeconds = options.fadeSeconds ?? DEFAULTS.fadeSeconds;
    this.sourcePreference = options.source ?? DEFAULTS.source;
    this.bufferMaxBytes = options.bufferMaxBytes ?? DEFAULTS.bufferMaxBytes;
    this.injectedContext = options.context;
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  on<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): () => void {
    return this.emitter.on(event, fn);
  }
  off<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): void {
    this.emitter.off(event, fn);
  }

  // ── Subscription contract (what framework bindings sit on) ──────────────────
  /**
   * Subscribe to discrete state changes. Returns an unsubscribe function.
   * Time updates are NOT discrete changes; read `currentTime` for those.
   */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** The current discrete state. Referentially stable while nothing changes. */
  getSnapshot(): EkoSnapshot {
    return this.snapshot;
  }

  /** Rebuild the snapshot and notify, but only if something actually changed. */
  private publish(): void {
    const next: EkoSnapshot = {
      state: this._state,
      paused: this._paused,
      index: this.index,
      track: this.current?.track ?? this.queue[this.index] ?? null,
      duration: this.current?.duration ?? 0,
      volume: this._volume,
      muted: this._muted,
      lastTransition: this._lastTransition,
      sourceKind: this.current?.kind ?? null,
    };
    if (snapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const fn of [...this.subscribers]) fn();
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
  /** The engine's resolved options. `gapless` and `transition` always agree with each other. */
  get config(): {
    normalize: boolean;
    targetLufs: number;
    gapless: boolean;
    transition: TransitionKind;
  } {
    return {
      normalize: this.normalize,
      targetLufs: this.targetLufs,
      gapless: this.transition === "gapless",
      transition: this.transition,
    };
  }
  get duration(): number {
    return this.current?.duration ?? 0;
  }
  get currentIndex(): number {
    return this.index;
  }
  /** What happened at the most recent boundary, or null before the first one. */
  get lastTransition(): TransitionKind | null {
    return this._lastTransition;
  }
  get currentTime(): number {
    if (!this.current) return 0;
    if (this._paused || !this.ctx) return this.startOffset;
    const t = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
    return Math.max(0, Math.min(t, this.current.duration));
  }

  // ── Queue / load ────────────────────────────────────────────────────────────
  setQueue(tracks: EkoTrack[]): void {
    // Invalidate any in-flight load (a gap-advance, a skip) before it can assign state
    // this new queue owns now.
    this.advanceToken++;
    this.teardown();
    this.queue = tracks.slice();
    this.index = tracks.length > 0 ? 0 : -1;
    this._paused = true;
    this.publish();
    if (this.index >= 0) void this.loadIndex(0, this.advanceToken);
  }

  load(srcOrTrack: string | EkoTrack): void {
    const track: EkoTrack = typeof srcOrTrack === "string" ? { src: srcOrTrack } : srcOrTrack;
    this.setQueue([track]);
  }

  /**
   * `token` is the value of `advanceToken` when this load started (see its declaration).
   * Re-checked after the await: a load superseded by a newer setQueue(), skipTo() or
   * destroy() call must not assign `current`/`index` or emit anything, since a later call
   * already owns the engine's state by the time this one would.
   */
  private async loadIndex(index: number, token: number): Promise<void> {
    const track = this.queue[index];
    if (!track) return;
    this.setState("loading");
    this.emitter.emit("loadstart", { index });
    try {
      const loaded = await this.loadTrack(track);
      if (token !== this.advanceToken) {
        loaded.dispose();
        return;
      }
      loaded.connect(this.graph!.input);
      loaded.onEnded(() => this.handleSourceEnded());
      this.current?.dispose();
      this.current = loaded;
      this.index = index;
      this.startOffset = 0;
      this.setState("ready");
      this.emitter.emit("loadedmetadata", { index, duration: loaded.duration });
      this.emitter.emit("durationchange", { duration: loaded.duration });
      this.emitter.emit("canplay", { index });
      this.publish();
      if (this.playRequested) {
        this.playRequested = false;
        void this.play();
      }
    } catch (error) {
      // A superseded load's own failure is not this engine's problem to report either.
      if (token !== this.advanceToken) return;
      this.setState("error");
      this.emitter.emit("error", { error: asEkoError(error, "decode_failed") });
    }
  }

  private async loadTrack(track: EkoTrack): Promise<LoadedSource> {
    const ctx = this.ensureGraph();
    const strategy = await selectStrategy(track, {
      source: this.sourcePreference,
      bufferMaxBytes: this.bufferMaxBytes,
    });
    return strategy.load(track, ctx, {
      normalize: this.normalize,
      targetLufs: this.targetLufs,
    });
  }

  // ── Transport ───────────────────────────────────────────────────────────────
  async play(): Promise<void> {
    if (this.advancing) {
      // A gap-advance is mid-load; `current` still points at the just-ended, disposable
      // source, so starting it now would audibly replay the wrong track. A resume is
      // already queued for when the load settles (see advanceWithGap), so play() and
      // pause() during this window are just competing intents: treat this as cancelling
      // any pause requested in the meantime, and otherwise do nothing.
      this.pauseRequestedDuringAdvance = false;
      return;
    }
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
    if (!this.current) {
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
    if (this._paused) {
      // Nothing audible to fade: either genuinely idle, or a gap-advance is mid-load and
      // already forced `_paused` true. In the latter case record the intent so the advance
      // does not resume playback once its load settles; see `advanceWithGap`.
      if (this.advancing) this.pauseRequestedDuringAdvance = true;
      return;
    }
    const ctx = this.ctx!;
    const position = this.currentTime; // capture before the source stops
    // Ramp down, then stop on the ramp's last sample so the cut is silent.
    const rampEnd = rampTo(this.graph!.fadeGain.gain, 0, ctx.currentTime, this.fadeSeconds);
    this.stopSource(rampEnd);
    this.clearArmed();
    this.startOffset = position;
    this._paused = true;
    this.setState("paused");
    this.stopRaf();
    this.emitter.emit("pause");
  }

  seek(time: number): void {
    if (!this.current) return;
    const t = Math.max(0, Math.min(time, this.current.duration));
    if (this._paused) {
      this.startOffset = t;
    } else {
      const ctx = this.ctx!;
      // Ramp out, cut at the ramp end, and start the new position there. startSource
      // fades back in from silence, so the seek is inaudible in both directions.
      const rampEnd = rampTo(this.graph!.fadeGain.gain, 0, ctx.currentTime, this.fadeSeconds);
      this.stopSource(rampEnd);
      this.clearArmed();
      this.startSource(t, rampEnd);
      void this.armNext(); // re-arm from the new position
    }
    this.emitter.emit("timeupdate", { currentTime: t, duration: this.current.duration });
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
    // Invalidate any in-flight load (a gap-advance, another skip) before it can assign
    // state this skip now owns.
    this.advanceToken++;
    const token = this.advanceToken;
    // A gap-advance forces `_paused` true purely as internal bookkeeping while it loads,
    // and fully intends to resume; a skip that interrupts it should honour that intent too,
    // not just the case where `_paused` was already false. The one exception is a real
    // pause() called during that advance, which pauseRequestedDuringAdvance records.
    const wasPlaying = !this._paused || (this.advancing && !this.pauseRequestedDuringAdvance);
    // This skip now owns the engine's state, so any advance it just superseded is no longer
    // "in flight" from here on, whether or not that advance's own load has settled yet.
    // play() below (or its own deferred call, once this load resolves) must not be blocked
    // by advancing still reading true from a stale advance that has not noticed it lost.
    this.advancing = false;
    if (wasPlaying) {
      // Ramp out, then cut on the ramp's last sample, the same shape as pause() and seek():
      // a manual skip is still an abrupt stop for the current track, so it must not click.
      const ctx = this.ctx!;
      const rampEnd = rampTo(this.graph!.fadeGain.gain, 0, ctx.currentTime, this.fadeSeconds);
      this.stopSource(rampEnd);
    } else {
      this.stopSource();
    }
    this.clearArmed();
    this._paused = true;
    this.stopRaf();
    await this.loadIndex(index, token);
    if (token !== this.advanceToken) {
      // Superseded (setQueue() or a newer skip) while this one was loading; whichever call
      // superseded it owns the engine's state now.
      return;
    }
    this._lastTransition = "gap";
    this.publish();
    const track = this.queue[index];
    if (track) this.emitter.emit("trackchange", { index, track, transition: "gap" });
    if (wasPlaying) void this.play();
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.graph && !this._muted) this.graph.userGain.gain.value = this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
    this.publish();
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.graph) this.graph.userGain.gain.value = muted ? 0 : this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
    this.publish();
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
    // Invalidate any in-flight load so it cannot resurrect a context or state after this.
    this.advanceToken++;
    this.teardown();
    this.current?.dispose();
    this.current = null;
    this.emitter.clear();
    this.graph?.destroy();
    this.graph = null;
    if (this.ctx && !this.injectedContext) void this.ctx.close();
    this.ctx = null;
  }

  // ── Gapless internals ─────────────────────────────────────────────────────────
  /** Decode the next queued track and schedule it to start the instant this one ends. */
  private async armNext(): Promise<void> {
    if (this.transition !== "gapless" || this._paused || !this.current || !this.ctx) return;
    // A streaming source cannot be scheduled to a sample, so this boundary cannot be
    // gapless no matter what the next track is.
    if (!this.current.canGapless) return;
    const nextIndex = this.index + 1;
    if (nextIndex >= this.queue.length || this.armed) return;
    const track = this.queue[nextIndex];
    if (!track) return;

    // The boundary is fixed once the current source started (start time + offset).
    const endCtxTime = trackEndTime(this.startCtxTime, this.current.duration, this.startOffset);

    let next: LoadedSource;
    try {
      next = await this.loadTrack(track);
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
    if (this._paused || !this.ctx || this.index !== nextIndex - 1 || this.armed) {
      next.dispose();
      return;
    }
    if (!next.canGapless) {
      // The incoming track streams, so it cannot start on a sample. Fall back to a gap.
      next.dispose();
      return;
    }

    next.connect(this.graph!.input);
    next.onEnded(() => this.handleSourceEnded());
    next.start(endCtxTime, 0);
    // Jump the shared normalization gain to the next track's value exactly at the boundary.
    this.graph!.rgGain.gain.setValueAtTime(next.normGain, endCtxTime);
    this.armed = { loaded: next, index: nextIndex, startCtxTime: endCtxTime };
  }

  /** A source reached its natural end. Promote the armed track, advance with a gap, or stop. */
  private handleSourceEnded(): void {
    if (this.armed) {
      const armed = this.armed;
      this.armed = null;
      this.current?.dispose();
      this.current = armed.loaded;
      this.index = armed.index;
      this.startCtxTime = armed.startCtxTime;
      this.startOffset = 0;
      this._lastTransition = "gapless";
      this.publish();
      this.emitter.emit("durationchange", { duration: armed.loaded.duration });
      this.emitter.emit("trackchange", {
        index: armed.index,
        track: armed.loaded.track,
        transition: "gapless",
      });
      void this.armNext();
    } else if (this.index + 1 < this.queue.length) {
      // Nothing was armed: the policy asked for a gap, a streaming source was involved, or
      // the prefetch failed. Advance anyway, and be honest that there was a gap.
      void this.advanceWithGap(this.index + 1);
    } else {
      this.handleNaturalEnd();
    }
  }

  /** Load and play the given index from a standing start. The boundary is audibly a gap. */
  private async advanceWithGap(index: number): Promise<void> {
    this.stopRaf();
    this._paused = true;
    this.advancing = true;
    const token = this.advanceToken;
    await this.loadIndex(index, token);
    this.advancing = false;
    // The flag only means anything while an advance is in flight; reset it here,
    // unconditionally, the moment this one settles, so a pause requested during THIS
    // advance can never leak into a later, unrelated advance, regardless of whether this
    // one was superseded. Read it into a local first: the normal path below still needs
    // to know what it was.
    const pauseRequested = this.pauseRequestedDuringAdvance;
    this.pauseRequestedDuringAdvance = false;
    if (token !== this.advanceToken) {
      // Superseded by setQueue(), skipTo() or destroy() while this was loading. Whichever
      // call superseded it owns the engine's state now; this advance has nothing left to
      // do, not even reporting the boundary, since it never actually reached track `index`.
      return;
    }
    this._lastTransition = "gap";
    this.publish();
    const track = this.queue[index];
    if (track) this.emitter.emit("trackchange", { index, track, transition: "gap" });
    if (pauseRequested) {
      // The consumer asked to pause while this load was in flight. Honour that instead of
      // resuming: the load already left the engine paused, so there is nothing more to do.
      return;
    }
    await this.play();
  }

  private clearArmed(): void {
    if (this.armed) {
      this.armed.loaded.dispose();
      this.armed = null;
    }
    if (this.ctx && this.graph) {
      this.graph.rgGain.gain.cancelScheduledValues(this.ctx.currentTime);
      if (this.current) this.graph.rgGain.gain.value = this.current.normGain;
    }
  }

  private handleNaturalEnd(): void {
    this.stopRaf();
    this._paused = true;
    this.startOffset = this.current?.duration ?? 0;
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

  private startSource(offset: number, when?: number): void {
    const ctx = this.ctx!;
    const current = this.current!;
    const at = when ?? ctx.currentTime;
    this.graph!.rgGain.gain.value = current.normGain;
    current.start(at, offset);
    this.startCtxTime = at;
    this.startOffset = offset;

    // Fade in from silence so starting mid-waveform does not click.
    const fade = this.graph!.fadeGain.gain;
    fade.cancelScheduledValues(at);
    fade.setValueAtTime(0, at);
    fade.linearRampToValueAtTime(1, at + this.fadeSeconds);
  }

  private stopSource(when?: number): void {
    this.current?.stop(when);
  }

  /** Stop both the current and armed sources (used by pause/seek/skip/destroy). */
  private teardown(): void {
    this.stopSource();
    this.clearArmed();
    this.stopRaf();
  }

  private setState(s: EkoState): void {
    this._state = s;
    this.publish();
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
