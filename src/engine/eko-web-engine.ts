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
  // `loading` is true for the whole span of any in-flight loadIndex() call: the initial
  // load from setQueue(), a manual skipTo(), or a gap-advance. The engine's own source must
  // not be touched during that window (there may be nothing to touch, or touching it would
  // race the load), so play()/pause() called during it cannot act immediately. Instead they
  // record what the consumer actually wants in `pendingIntent`, and whichever call owns the
  // load (checked via `advanceToken`, same as everywhere else) honours it once the load
  // settles. This is one mechanism for all three windows, not three separate flags: a
  // load-in-flight has exactly one outstanding intent at a time, and the most recent
  // play()/pause() call during it is what should happen next, however many windows deep the
  // consumer's clicks land.
  private loading = false;
  private pendingIntent: "play" | "pause" | null = null;
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
  /** The linear normalization gain applied to the current track (1 = none). */
  get normGain(): number {
    return this.current?.normGain ?? 1;
  }

  // ── Queue / load ────────────────────────────────────────────────────────────
  setQueue(tracks: EkoTrack[]): void {
    // Invalidate any in-flight load (a gap-advance, a skip) before it can assign state
    // this new queue owns now.
    this.advanceToken++;
    const token = this.advanceToken;
    this.teardown();
    this.queue = tracks.slice();
    this.index = tracks.length > 0 ? 0 : -1;
    this._paused = true;
    // A new queue starts with no intent of its own; any play()/pause() during its own
    // initial load is what sets one, same as the other two windows.
    this.pendingIntent = null;
    this.publish();
    if (this.index >= 0) void this.startLoad(0, token);
  }

  load(srcOrTrack: string | EkoTrack): void {
    const track: EkoTrack = typeof srcOrTrack === "string" ? { src: srcOrTrack } : srcOrTrack;
    this.setQueue([track]);
  }

  /** The initial load for a queue has no boundary of its own to report; just honour intent. */
  private async startLoad(index: number, token: number): Promise<void> {
    await this.loadIndex(index, token);
    if (token !== this.advanceToken) return;
    this.resolvePendingIntent();
  }

  /**
   * `token` is the value of `advanceToken` when this load started (see its declaration).
   * Re-checked after the await: a load superseded by a newer setQueue(), skipTo() or
   * destroy() call must not assign `current`/`index` or emit anything, since a later call
   * already owns the engine's state by the time this one would.
   *
   * Sets `loading` for its whole span; see that field's declaration for why. Never resumes
   * playback itself — callers that have a boundary to report (skipTo(), advanceWithGap())
   * do that first, then call `resolvePendingIntent()` themselves, so `play` never fires
   * before the `trackchange` it belongs after.
   */
  private async loadIndex(index: number, token: number): Promise<void> {
    const track = this.queue[index];
    if (!track) return;
    this.loading = true;
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
      this.loading = false;
      this.setState("ready");
      this.emitter.emit("loadedmetadata", { index, duration: loaded.duration });
      this.emitter.emit("durationchange", { duration: loaded.duration });
      this.emitter.emit("canplay", { index });
      this.publish();
    } catch (error) {
      // A superseded load's own failure is not this engine's problem to report either.
      if (token !== this.advanceToken) return;
      this.loading = false;
      this.setState("error");
      this.emitter.emit("error", { error: asEkoError(error, "decode_failed") });
    }
  }

  /** Act on whatever play()/pause() asked for while a load this token owns was in flight. */
  private resolvePendingIntent(): void {
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    if (intent === "play") void this.play();
    // "pause" or null: the load already left the engine paused with nothing started; there
    // is nothing further to do.
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
    if (this.loading) {
      // A load is mid-flight (the initial load, a skip, or a gap-advance): `current` may
      // not exist yet, or may still point at a just-ended, disposable source, so starting
      // anything now would either do nothing or audibly replay the wrong track. Record the
      // intent; whichever call owns this load resumes for us once it settles.
      this.pendingIntent = "play";
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
      // Nothing loaded and nothing loading either (no setQueue() call has happened yet).
      // There is no in-flight load for an intent to attach to.
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
    if (this.loading) {
      // Same load-in-flight window play() guards above. Record the intent instead of
      // touching a source that may not exist yet, or that the load is about to replace.
      this.pendingIntent = "pause";
      return;
    }
    if (this._paused) return; // genuinely idle already; nothing audible to fade
    const position = this.currentTime; // capture before the source stops
    this.fadeOutAndStop();
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
      // Ramp out, cut at the ramp end, and start the new position there. startSource
      // fades back in from silence, so the seek is inaudible in both directions.
      const rampEnd = this.fadeOutAndStop();
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
    // Another load may already be in flight (the initial load, a gap-advance, or another
    // skip): in that case `_paused` is just that load's bookkeeping, not real transport
    // state, so what "was playing" actually means is whatever that load's own pending
    // intent currently is (which a pause() during its window may already have changed).
    // Otherwise it is the real, current paused state.
    const wasPlaying = this.loading ? this.pendingIntent === "play" : !this._paused;
    // This skip now owns the engine's state and is about to start its own load, so record
    // its intent before anything else can read a stale one, and so any load it just
    // superseded is no longer "in flight" from here on, whether or not that load's own
    // await has settled yet.
    this.pendingIntent = wasPlaying ? "play" : null;
    if (wasPlaying) {
      // Ramp out, then cut on the ramp's last sample, the same shape as pause() and seek():
      // a manual skip is still an abrupt stop for the current track, so it must not click.
      this.fadeOutAndStop();
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
    this.resolvePendingIntent();
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
    // An advance always intends to resume once it settles (that is the whole point: the
    // consumer was mid-playback when the track ended), unless a pause() during its window
    // says otherwise. This is that default, in the same field a pause() or play() during
    // the window overwrites.
    this.pendingIntent = "play";
    const token = this.advanceToken;
    await this.loadIndex(index, token);
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
    this.resolvePendingIntent();
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
    if (when === undefined) {
      // A standalone start (e.g. resuming from a stop): nothing is scheduled at `at`, so
      // pin the value there before ramping up.
      fade.cancelScheduledValues(at);
      fade.setValueAtTime(0, at);
    }
    // When `when` IS given, `at` is the exact end time of a fade-out `fadeOutAndStop()`
    // just scheduled on this same call chain (see seek()), which already lands the gain
    // at 0 at `at`. Cancelling here would delete that ramp's own landing event: the
    // automation would fall back to holding whatever value preceded it (near full) right
    // up to the cut, instead of having actually ramped down, producing exactly the click
    // fades exist to prevent. Leaving it alone means the ramp-up below just continues
    // from where the ramp-out left off.
    fade.linearRampToValueAtTime(1, at + this.fadeSeconds);
  }

  private stopSource(when?: number): void {
    this.current?.stop(when);
  }

  /** Ramp fadeGain to silence and stop the current source at the ramp's end. */
  private fadeOutAndStop(): number {
    const ctx = this.ctx!;
    const rampEnd = rampTo(this.graph!.fadeGain.gain, 0, ctx.currentTime, this.fadeSeconds);
    this.stopSource(rampEnd);
    return rampEnd;
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
