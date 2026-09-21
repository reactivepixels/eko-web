import { Emitter } from "./event-emitter";
import { EkoError, type EkoErrorCode } from "./errors";
import { EkoGraph } from "./graph";
import { trackEndTime } from "./scheduling";
import { rampTo, DEFAULT_FADE_SECONDS } from "./fades";
import { selectStrategy } from "./sources/select";
import type { LoadedSource } from "./sources/source";
import { EMPTY_SNAPSHOT, snapshotsEqual, type EkoSnapshot } from "./snapshot";
import { EkoQueue, type RepeatMode } from "../queue/queue";
import type {
  EkoTrack,
  EkoState,
  EkoWebEngineOptions,
  EkoEventName,
  EkoEventListener,
  TransitionKind,
} from "../types";

/**
 * The next track, loaded and scheduled to start at exactly `startCtxTime`. Under gapless
 * that is the boundary itself; under crossfade it is earlier, by the overlap.
 */
interface ArmedTrack {
  loaded: LoadedSource;
  index: number;
  startCtxTime: number;
}

/**
 * A duration option, or the default when the caller hands over something that is not one.
 *
 * These land in `source.start()` and in ramp end times as plain arithmetic, so a bad value
 * does not fail where it was passed: a negative overlap schedules the next track after the
 * boundary instead of before it, and NaN poisons every time derived from it. An empty
 * number input in a browser produces NaN, so neither needs anyone to be doing anything
 * strange.
 */
function seconds(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

const DEFAULTS = {
  normalize: true,
  targetLufs: -16,
  transition: "gapless" as TransitionKind,
  crossfadeSeconds: 3,
  fadeSeconds: DEFAULT_FADE_SECONDS,
  source: "auto" as const,
  bufferMaxBytes: 50 * 1024 * 1024,
};

/**
 * Web Audio playback engine: each track plays through a selectable source strategy
 * (decode to buffer, or stream via a media element), through its own ReplayGain-style
 * normalization gain, into a shared graph (`input → fadeGain → userGain → destination`).
 * Sample-accurate transitions (gapless or crossfade) only happen between buffered tracks;
 * see `source` and `bufferMaxBytes` in `EkoWebEngineOptions`.
 *
 * NOT bit-perfect. See the project README.
 */
export class EkoWebEngine {
  private emitter = new Emitter();
  private readonly normalize: boolean;
  private readonly targetLufs: number;
  private readonly transition: TransitionKind;
  private readonly crossfadeSeconds: number;
  private _lastTransition: TransitionKind | null = null;
  private readonly fadeSeconds: number;
  private readonly sourcePreference: "auto" | "buffer" | "element";
  private readonly bufferMaxBytes: number;
  private readonly injectedContext?: AudioContext;

  private ctx: AudioContext | null = null;
  private graph: EkoGraph | null = null;

  /** Ordering lives here so the scheduler can ask what plays next before the boundary. */
  private readonly tracks = new EkoQueue();
  private current: LoadedSource | null = null;
  private armed: ArmedTrack | null = null;

  private _state: EkoState = "idle";
  private _volume = 1;
  private _muted = false;
  private _paused = true;
  /** True once destroy() has run. Guards every method that could otherwise resurrect an
   * AudioContext or touch a graph/source that no longer exists. */
  private destroyed = false;

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
  // The boundary an armNext() call is currently loading for: the queue index it targets and
  // the source it is scheduled behind. Arming is async, and several calls can ask for the
  // same boundary in quick succession (a scrub issues one per seek()); without this each
  // one runs its own fetch and decode of the same track and throws all but one away, which
  // for a five minute FLAC is hundreds of megabytes of transient decode. The source is part
  // of the key, not just the index, because a boundary that has since been crossed can land
  // back on the same index (repeat "one"), and that genuinely does need arming again.
  private arming: { index: number; source: LoadedSource } | null = null;
  private rafHandle: number | null = null;
  // Sources that were stopped on the last sample of a fade already in flight, held here
  // until that sample has actually passed. Tearing one down disconnects its own gain node,
  // which silences it instantly, so doing it at the moment of the stop call would cut
  // exactly the tail the fade was scheduled to cover. Tracked rather than fired and
  // forgotten so destroy() can settle them instead of leaving handles pointed at a context
  // that is closing.
  private deferredDisposals = new Map<ReturnType<typeof setTimeout>, LoadedSource>();

  constructor(options: EkoWebEngineOptions = {}) {
    this.normalize = options.normalize ?? DEFAULTS.normalize;
    this.targetLufs = options.targetLufs ?? DEFAULTS.targetLufs;
    this.transition = options.transition ?? DEFAULTS.transition;
    this.crossfadeSeconds = seconds(options.crossfadeSeconds, DEFAULTS.crossfadeSeconds);
    this.fadeSeconds = seconds(options.fadeSeconds, DEFAULTS.fadeSeconds);
    this.sourcePreference = options.source ?? DEFAULTS.source;
    this.bufferMaxBytes = options.bufferMaxBytes ?? DEFAULTS.bufferMaxBytes;
    this.injectedContext = options.context;
    this.tracks.shuffle = options.shuffle ?? false;
    this.tracks.repeat = options.repeat ?? "none";
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
      index: this.tracks.currentIndex,
      queueLength: this.tracks.length,
      track: this.current?.track ?? this.tracks.current ?? null,
      duration: this.current?.duration ?? 0,
      volume: this._volume,
      muted: this._muted,
      lastTransition: this._lastTransition,
      sourceKind: this.current?.kind ?? null,
      shuffle: this.tracks.shuffle,
      repeat: this.tracks.repeat,
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
  /** The engine's fully resolved options, defaults included, so a consumer never has to
   * guess what actually applied. */
  get config(): {
    normalize: boolean;
    targetLufs: number;
    transition: TransitionKind;
    crossfadeSeconds: number;
    fadeSeconds: number;
    source: "auto" | "buffer" | "element";
    bufferMaxBytes: number;
  } {
    return {
      normalize: this.normalize,
      targetLufs: this.targetLufs,
      transition: this.transition,
      crossfadeSeconds: this.crossfadeSeconds,
      fadeSeconds: this.fadeSeconds,
      source: this.sourcePreference,
      bufferMaxBytes: this.bufferMaxBytes,
    };
  }
  get duration(): number {
    return this.current?.duration ?? 0;
  }
  /**
   * How far into the current track playable data extends, in seconds. Always `duration`
   * for the buffer strategy; for the element strategy this is the browser's own live
   * buffered range, and genuinely grows over time. A getter, like `currentTime`, since it
   * changes continuously rather than on a discrete boundary.
   */
  get bufferedEnd(): number {
    return this.current?.bufferedEnd ?? 0;
  }
  get currentIndex(): number {
    return this.tracks.currentIndex;
  }
  /** What happened at the most recent boundary, or null before the first one. */
  get lastTransition(): TransitionKind | null {
    return this._lastTransition;
  }
  get shuffle(): boolean {
    return this.tracks.shuffle;
  }
  get repeat(): RepeatMode {
    return this.tracks.repeat;
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
    this.assertNotDestroyed();
    // Invalidate any in-flight load (a gap-advance, a skip) before it can assign state
    // this new queue owns now.
    this.advanceToken++;
    const token = this.advanceToken;
    let rampEnd: number | undefined;
    if (!this._paused && this.current) {
      // A track is actively playing and setQueue() (or load(), or the facade's `src`
      // setter, which both funnel through here) is about to cut it out from under the
      // listener. Fade it out the same shape pause/seek/skip already use, instead of a
      // hard cut. destroy() below uses the plain teardown() instead: the context is
      // closing there, so a scheduled fade has nobody left to reach.
      rampEnd = this.fadeOutAndStop();
    } else {
      this.stopSource();
    }
    this.clearArmed(rampEnd);
    this.stopRaf();
    this.tracks.setTracks(tracks);
    this._paused = true;
    // A new queue starts with no intent of its own; any play()/pause() during its own
    // initial load is what sets one, same as the other two windows.
    this.pendingIntent = null;
    this.publish();
    if (this.tracks.currentIndex >= 0) void this.startLoad(0, token);
  }

  load(srcOrTrack: string | EkoTrack): void {
    const track: EkoTrack = typeof srcOrTrack === "string" ? { src: srcOrTrack } : srcOrTrack;
    this.setQueue([track]);
  }

  /** The initial load for a queue has no boundary of its own to report; just honour intent. */
  private async startLoad(index: number, token: number): Promise<void> {
    const track = this.tracks.current;
    if (!track) return;
    await this.loadIndex(index, track, token);
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
   * playback itself: callers that have a boundary to report (skipTo(), advanceWithGap())
   * do that first, then call `resolvePendingIntent()` themselves, so `play` never fires
   * before the `trackchange` it belongs after.
   *
   * This never touches the queue's position; the caller passes the exact `track` to load.
   * `skipTo()` and `startLoad()` call this once the queue already sits at `index` (they moved
   * it first). `advanceWithGap()` is the one exception: it passes a peeked track and only
   * commits the queue's move, via `advance()`, once this load actually succeeds, so a manual
   * `next()`/`previous()` racing an in-flight gap-advance still sees the queue where it was.
   *
   * `stillValid`, when supplied, is checked at the same instant as `token`, right after the
   * await and before anything is assigned: it catches a change to what plays next that does
   * not bump `advanceToken` (a shuffle or repeat toggle mid-load). Only `advanceWithGap()`
   * passes one; `skipTo()` and `startLoad()` have already moved the queue to `index` before
   * calling this, so `token` alone is enough for them.
   *
   * The two rejections below look similar but leave different obligations. A `token`
   * mismatch means another call (setQueue()/skipTo()/destroy()) already owns the engine
   * and is issuing its own loadIndex() that will reset `loading`/state itself, so this one
   * leaves them alone. A `stillValid` failure has no such successor: nothing else is
   * coming to clean up, so this call must leave the engine coherent by itself, or `loading`
   * stays true and `play()`/`pause()` go silently dead until some unrelated call happens to
   * bump the token later.
   */
  private async loadIndex(
    index: number,
    track: EkoTrack,
    token: number,
    stillValid?: () => boolean,
  ): Promise<void> {
    this.loading = true;
    this.setState("loading");
    this.emitter.emit("loadstart", { index });
    try {
      const loaded = await this.loadTrack(track);
      if (token !== this.advanceToken) {
        loaded.dispose();
        return;
      }
      if (stillValid && !stillValid()) {
        // `current` was never touched by this call, so it is still a valid, ready track;
        // restore the bookkeeping this load claimed at the top so the engine is not left
        // permanently mid-load. What happens next (retry against the new answer, or
        // settle) is the caller's decision, made below in advanceWithGap().
        loaded.dispose();
        this.loading = false;
        this.setState("ready");
        return;
      }
      loaded.connect(this.graph!.input);
      loaded.onEnded(() => this.handleSourceEnded());
      loaded.onStartError((error) => this.handleStartError(error));
      this.current?.dispose();
      this.current = loaded;
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
    this.assertNotDestroyed();
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
    this.assertNotDestroyed();
    if (this.loading) {
      // Same load-in-flight window play() guards above. Record the intent instead of
      // touching a source that may not exist yet, or that the load is about to replace.
      this.pendingIntent = "pause";
      return;
    }
    if (this._paused) return; // genuinely idle already; nothing audible to fade
    const position = this.currentTime; // capture before the source stops
    const rampEnd = this.fadeOutAndStop();
    this.clearArmed(rampEnd);
    this.startOffset = position;
    this._paused = true;
    this.setState("paused");
    this.stopRaf();
    this.emitter.emit("pause");
  }

  seek(time: number): void {
    this.assertNotDestroyed();
    if (!this.current) return;
    const t = Math.max(0, Math.min(time, this.current.duration));
    if (this._paused) {
      this.startOffset = t;
    } else {
      // Ramp out, cut at the ramp end, and start the new position there. startSource
      // fades back in from silence, so the seek is inaudible in both directions.
      const rampEnd = this.fadeOutAndStop();
      this.clearArmed(rampEnd);
      this.startSource(t, rampEnd);
      void this.armNext(); // re-arm from the new position
    }
    this.emitter.emit("timeupdate", { currentTime: t, duration: this.current.duration });
  }

  /** Skip to the next track (manual, so a small decode gap is acceptable here). */
  next(): void {
    this.assertNotDestroyed();
    const target = this.tracks.peekNextIndex();
    if (target < 0) return;
    const from = this.tracks.currentIndex;
    this.tracks.advance();
    void this.skipTo(target, from);
  }

  /** Step back through what was actually played, which under shuffle is not index minus one. */
  previous(): void {
    this.assertNotDestroyed();
    const from = this.tracks.currentIndex;
    const target = this.tracks.stepBack();
    if (target >= 0) void this.skipTo(target, from);
  }

  /** Changing this reshuffles the remaining tracks; it does not disturb what is playing. */
  setShuffle(on: boolean): void {
    this.assertNotDestroyed();
    // What the re-arm below actually cares about is whether what plays next changed, not
    // whether the flag did: comparing peekNextIndex() before and after, rather than just
    // `on` against the old value, also skips the teardown on the rarer case where the flag
    // flips but the bag's first draw happens to land back on the same index.
    const nextBefore = this.tracks.peekNextIndex();
    this.tracks.shuffle = on;
    this.publish();
    if (this.tracks.peekNextIndex() === nextBefore) return;
    // What plays next changed, so anything already armed is now the wrong track.
    this.clearArmed();
    void this.armNext();
  }

  setRepeat(mode: RepeatMode): void {
    this.assertNotDestroyed();
    const nextBefore = this.tracks.peekNextIndex();
    this.tracks.repeat = mode;
    this.publish();
    if (this.tracks.peekNextIndex() === nextBefore) return;
    this.clearArmed();
    void this.armNext();
  }

  /**
   * `rollbackTo` is where the queue sat before the caller moved it to `index`. next()/
   * previous() move the queue eagerly, before this load even starts, so a rapid second
   * press can compute its own target from the right place. If this specific load then
   * fails, that eager move is now wrong: the listener is still on the old track, so the
   * queue is put back, or getSnapshot() would report the failed index against the track
   * that is actually still loaded.
   */
  private async skipTo(index: number, rollbackTo: number): Promise<void> {
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
    let rampEnd: number | undefined;
    if (wasPlaying) {
      // Ramp out, then cut on the ramp's last sample, the same shape as pause() and seek():
      // a manual skip is still an abrupt stop for the current track, so it must not click.
      rampEnd = this.fadeOutAndStop();
    } else {
      this.stopSource();
    }
    this.clearArmed(rampEnd);
    this._paused = true;
    this.stopRaf();
    // next()/previous() already moved the queue to `index` before calling this, so the
    // track to load is whatever the queue now says is current.
    const track = this.tracks.current;
    if (track) await this.loadIndex(index, track, token);
    if (token !== this.advanceToken) {
      // Superseded (setQueue() or a newer skip) while this one was loading; whichever call
      // superseded it owns the engine's state now.
      return;
    }
    if (this._state === "error") {
      // Nothing superseded this skip (the token still matches), so it still owns the
      // engine's state, but the load itself failed: `this.current` was never reassigned
      // (loadIndex's catch path leaves it alone), so the listener is still on the old
      // track. Put the queue back where it was, or getSnapshot() would report the failed
      // `index` against a `track` that never changed.
      this.tracks.jumpTo(rollbackTo);
    }
    this._lastTransition = "gap";
    this.publish();
    if (track) this.emitter.emit("trackchange", { index, track, transition: "gap" });
    this.resolvePendingIntent();
  }

  setVolume(v: number): void {
    this.assertNotDestroyed();
    this._volume = Math.max(0, Math.min(1, v));
    if (this.graph && !this._muted) this.graph.userGain.gain.value = this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
    this.publish();
  }

  setMuted(muted: boolean): void {
    this.assertNotDestroyed();
    this._muted = muted;
    if (this.graph) this.graph.userGain.gain.value = muted ? 0 : this._volume;
    this.emitter.emit("volumechange", { volume: this._volume, muted: this._muted });
    this.publish();
  }

  /** The engine's AudioContext, so consumers can build nodes to insert. */
  get context(): AudioContext {
    this.assertNotDestroyed();
    return this.ensureGraph();
  }

  /**
   * An AnalyserNode on the output, for spectrum and waveform displays. Created on first
   * access. The library exposes the data, never a canvas.
   */
  get analyser(): AnalyserNode {
    this.assertNotDestroyed();
    this.ensureGraph();
    return this.graph!.analyser;
  }

  /**
   * Insert your own nodes (an EQ, a compressor) after normalization and before the fader.
   * Pass an empty array to remove them. Inserts survive track changes.
   */
  setInserts(nodes: AudioNode[]): void {
    this.assertNotDestroyed();
    this.ensureGraph();
    this.graph!.setInserts(nodes);
  }

  /**
   * Tear the engine down: stop everything, release the AudioContext, and detach every
   * listener. Safe to call more than once. Every other method throws a coded `EkoError`
   * ("destroyed") after this, rather than silently resurrecting a fresh AudioContext or
   * operating on a graph that no longer exists. Browsers cap how many contexts a page can
   * create, and a stray callback (a React double-mount, an in-flight promise) reaching a
   * "destroyed" engine is exactly the case that cap gets hit by surprise.
   */
  destroy(): void {
    if (this.destroyed) return; // idempotent: a second destroy() is not misuse
    // Invalidate any in-flight load so it cannot resurrect a context or state after this.
    this.advanceToken++;
    this.teardown();
    // Nothing is left to fade into, so anything waiting on a fade's last sample is torn
    // down now rather than against a context that is about to close.
    for (const [handle, source] of this.deferredDisposals) {
      clearTimeout(handle);
      source.dispose();
    }
    this.deferredDisposals.clear();
    this.current?.dispose();
    this.current = null;
    this.tracks.setTracks([]);
    this._state = "idle";
    this._paused = true;
    this._lastTransition = null;
    this.loading = false;
    this.pendingIntent = null;
    this.destroyed = true;
    // One last, accurate snapshot before the subscription channel closes, so a consumer
    // reading through `subscribe`/`getSnapshot` (a framework binding's render, mid-unmount)
    // sees "idle, nothing loaded" rather than whatever was true the instant before destroy().
    this.publish();
    this.subscribers.clear();
    this.emitter.clear();
    this.graph?.destroy();
    this.graph = null;
    if (this.ctx && !this.injectedContext) void this.ctx.close();
    this.ctx = null;
  }

  /** Throws a coded EkoError if destroy() has already run. See destroy()'s own doc comment. */
  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new EkoError(
        "destroyed",
        "eko-web: this engine has been destroyed (destroy() was already called) and can no longer be used.",
      );
    }
  }

  // ── Gapless / crossfade internals ───────────────────────────────────────────────
  /**
   * Decode the next queued track and schedule it against this one's boundary. Under
   * `"gapless"` it starts the instant this one ends; under `"crossfade"` it starts early,
   * overlapping the tail of this one, with both sides ramping across the overlap.
   */
  private async armNext(): Promise<void> {
    if (this.transition === "gap" || this._paused || !this.current || !this.ctx) return;
    // A streaming source cannot be scheduled to a sample, so this boundary cannot be
    // gapless or crossfade no matter what the next track is.
    if (!this.current.canGapless) return;
    const nextIndex = this.tracks.peekNextIndex();
    if (nextIndex < 0 || this.armed) return;
    // What this arm is scheduled against, captured before the load so it can be checked
    // against the live values after it. `armed` cannot stand in for any of this: it is only
    // assigned once the load has already finished, which is far too late to notice that the
    // boundary moved underneath it.
    const token = this.advanceToken;
    const currentAtStart = this.current;
    if (this.isAlreadyArming(nextIndex, currentAtStart)) return;
    const track = this.tracks.peekNext();
    if (!track) return;

    let next: LoadedSource;
    this.arming = { index: nextIndex, source: currentAtStart };
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
    } finally {
      // Every path out of the load, including the rejections below, has to release this or
      // arming is dead for the rest of the session. Only release the marker this call set:
      // a later arm for a different boundary may already own it.
      if (this.arming?.index === nextIndex && this.arming.source === currentAtStart) {
        this.arming = null;
      }
    }
    if (
      this._paused ||
      !this.ctx ||
      // setQueue(), skipTo() or destroy() took the engine somewhere else mid-load.
      token !== this.advanceToken ||
      // A boundary was crossed while this loaded, so it is arming behind the track that is
      // actually playing now.
      this.current !== currentAtStart ||
      this.tracks.peekNextIndex() !== nextIndex ||
      this.armed
    ) {
      next.dispose();
      return;
    }
    if (!next.canGapless) {
      // The incoming track streams, so it cannot start on a sample. Fall back to a gap,
      // for gapless and crossfade alike: crossfade needs both sides sample-accurate.
      next.dispose();
      return;
    }

    // Read the clock now, not before the load. seek() moves the boundary without bumping
    // advanceToken and without replacing `current`, so neither check above can see it: an
    // arm still holding the clock it read when it started schedules the next track against
    // a boundary that has since moved, which is a whole seek's worth of silence (or of two
    // tracks playing at once) on a boundary this library exists to make seamless.
    const endCtxTime = trackEndTime(this.startCtxTime, currentAtStart.duration, this.startOffset);
    // Crossfade overlaps, gapless abuts. Clamp the overlap to what is actually left of the
    // outgoing track, so a long crossfade on a short (or already part-played) track cannot
    // schedule a start in the past, and to the incoming track's own duration, or the
    // incoming side would end first and its promotion would hard-stop the outgoing one
    // partway down its ramp.
    const remaining = Math.max(0, endCtxTime - this.ctx.currentTime);
    const overlap =
      this.transition === "crossfade"
        ? Math.min(this.crossfadeSeconds, remaining, next.duration)
        : 0;
    const startAt = endCtxTime - overlap;

    next.connect(this.graph!.input);
    next.onEnded(() => this.handleSourceEnded());
    next.start(startAt, 0);
    if (overlap > 0) {
      // Both sides ramp across the overlap: the outgoing track down to silence, the
      // incoming one up to its OWN normGain, not to 1, or normalization would be undone
      // for the incoming track at exactly the moment both are audible.
      const outgoing = currentAtStart.gain;
      const incoming = next.gain;
      if (outgoing) {
        outgoing.gain.cancelScheduledValues(startAt);
        outgoing.gain.setValueAtTime(currentAtStart.normGain, startAt);
        outgoing.gain.linearRampToValueAtTime(0, endCtxTime);
      }
      if (incoming) {
        incoming.gain.cancelScheduledValues(startAt);
        incoming.gain.setValueAtTime(0, startAt);
        incoming.gain.linearRampToValueAtTime(next.normGain, endCtxTime);
      }
    }
    // With no overlap (gapless), `next` already carries its own normalization gain from
    // connect(), so the level changes over at exactly the boundary for free.
    this.armed = { loaded: next, index: nextIndex, startCtxTime: startAt };
  }

  /** A source reached its natural end. Promote the armed track, advance with a gap, or stop. */
  private handleSourceEnded(): void {
    if (this.armed) {
      const armed = this.armed;
      this.armed = null;
      this.current?.dispose();
      this.current = armed.loaded;
      // The armed track was chosen by peekNextIndex(), and advance() moves to exactly that
      // index (peek is stable, so the two cannot disagree).
      this.tracks.advance();
      this.startCtxTime = armed.startCtxTime;
      this.startOffset = 0;
      this._lastTransition = this.transition === "crossfade" ? "crossfade" : "gapless";
      this.publish();
      this.emitter.emit("durationchange", { duration: armed.loaded.duration });
      this.emitter.emit("trackchange", {
        index: armed.index,
        track: armed.loaded.track,
        transition: this._lastTransition,
      });
      void this.armNext();
    } else {
      // Nothing was armed: the policy asked for a gap, a streaming source was involved, or
      // the prefetch failed. Advance anyway, and be honest that there was a gap. Unlike
      // next()/previous(), this does NOT move the queue up front: the boundary is async
      // (loadIndex has to await a load), and a manual next()/previous() must still be able
      // to read "where the queue actually is" while that load is in flight, not where a
      // not-yet-settled advance intends to land. See advanceWithGap().
      const nextIndex = this.tracks.peekNextIndex();
      if (nextIndex >= 0) {
        void this.advanceWithGap(nextIndex);
      } else {
        this.handleNaturalEnd();
      }
    }
  }

  /**
   * Load and play the given index from a standing start. The boundary is audibly a gap.
   *
   * `retriesLeft` bounds what happens when a shuffle or repeat toggle lands mid-load and
   * changes the answer (see the `stillValid` rejection in loadIndex()): a listener who
   * just changed the setting is asking for the new answer, not for playback to stop at
   * the old boundary, so this retries once against whatever plays next now. It is capped
   * at one retry, not chased indefinitely, so a caller that keeps changing the setting on
   * every tick cannot turn this into an unbounded chain of fetches; one retry covers the
   * realistic case (a single toggle landing mid-load) and gives up past that.
   */
  private async advanceWithGap(index: number, retriesLeft = 1): Promise<void> {
    this.stopRaf();
    this._paused = true;
    // An advance always intends to resume once it settles (that is the whole point: the
    // consumer was mid-playback when the track ended), unless a pause() during its window
    // says otherwise. This is that default, in the same field a pause() or play() during
    // the window overwrites.
    this.pendingIntent = "play";
    const token = this.advanceToken;
    // A pure read: the queue's position does not move until the load below actually
    // succeeds. If a manual next()/previous() supersedes this in the meantime, it sees the
    // queue exactly where it was, not pre-moved to where this advance was heading.
    const track = this.tracks.peekNext();
    if (track) {
      await this.loadIndex(index, track, token, () => this.tracks.peekNextIndex() === index);
    }
    if (token !== this.advanceToken) {
      // Superseded by setQueue(), skipTo() or destroy() while this was loading. Whichever
      // call superseded it owns the engine's state now; this advance has nothing left to
      // do, not even reporting the boundary, since it never actually reached track `index`.
      return;
    }
    // `token` only catches setQueue()/skipTo()/destroy(); it does not catch something that
    // changes what plays next without moving the queue's position (a shuffle or repeat
    // toggle) or without bumping advanceToken. The `stillValid` predicate passed to
    // loadIndex() above already rejects the load on exactly this condition before it ever
    // touches `current`, so this repeats the same check purely as defence in depth: it
    // still has to stop advance() and the trackchange below from firing even if a future
    // change to loadIndex() ever loosened that guard.
    const target = this.tracks.peekNextIndex();
    if (target !== index) {
      if (target >= 0 && retriesLeft > 0) {
        void this.advanceWithGap(target, retriesLeft - 1);
        return;
      }
      // Nothing left to chase: either there is genuinely nothing to advance to (the
      // toggle left the queue with no next track), or the bound above was hit. Either
      // way, loadIndex() already left `current` coherent; settle the same way the queue
      // naturally running out does, rather than leaving `pendingIntent` pointed at a
      // boundary this call has decided not to reach.
      this.pendingIntent = null;
      this.handleNaturalEnd();
      return;
    }
    // Only now, with the load confirmed to still be current, commit the move. The track
    // just loaded was chosen by peekNextIndex() above, and advance() moves to exactly that
    // index (peek is stable, so the two cannot disagree), the same guarantee the gapless
    // promotion above relies on.
    this.tracks.advance();
    this._lastTransition = "gap";
    this.publish();
    if (track) this.emitter.emit("trackchange", { index, track, transition: "gap" });
    this.resolvePendingIntent();
  }

  /** Whether an arm for exactly this boundary is already loading; see the `arming` field. */
  private isAlreadyArming(index: number, source: LoadedSource): boolean {
    return this.arming !== null && this.arming.index === index && this.arming.source === source;
  }

  /**
   * Drop whatever is armed and undo the outgoing half of the boundary it set up.
   *
   * armNext() schedules a real ramp on the CURRENT source's own gain as the outgoing side
   * of a crossfade, and that automation lives on the AudioParam, not on the armed track,
   * so disposing the armed track alone leaves the outgoing side ramping to (and then held
   * at) silence with nothing left to hand over to. Pinning here rather than at each call
   * site is what makes that impossible to forget: skipTo() and setQueue() both keep
   * `this.current` when their own load fails, and would otherwise resume a track whose
   * gain is pinned at 0 while reporting "playing".
   *
   * `when` is the AudioContext time a fade already in flight reaches silence. Callers that
   * have one pass it, because mid-crossfade the armed source is audible: it is stopped on
   * the fade's last sample instead of where it stands, and the current gain is pinned
   * there too, so the outgoing side holds its level through the fade rather than stepping
   * back to full while it can still be heard. Callers with no fade in flight pass nothing
   * and get the immediate teardown, which is all gapless ever needed.
   */
  private clearArmed(when?: number): void {
    const armed = this.armed;
    this.armed = null;
    if (armed) {
      if (when === undefined) armed.loaded.dispose();
      else this.stopAndDisposeAt(armed.loaded, when);
    }
    this.pinCurrentGain(when);
  }

  /** Stop `source` at `when` and tear it down only once that time has passed; see the
   * `deferredDisposals` field for why the teardown cannot happen at the same instant. */
  private stopAndDisposeAt(source: LoadedSource, when: number): void {
    source.stop(when);
    const delayMs = Math.max(0, (when - (this.ctx?.currentTime ?? when)) * 1000);
    const handle = setTimeout(() => {
      this.deferredDisposals.delete(handle);
      source.dispose();
    }, delayMs);
    this.deferredDisposals.set(handle, source);
  }

  private handleNaturalEnd(): void {
    this.stopRaf();
    this._paused = true;
    this.startOffset = this.current?.duration ?? 0;
    this.setState("ended");
    this.emitter.emit("timeupdate", { currentTime: this.duration, duration: this.duration });
    this.emitter.emit("ended");
  }

  /**
   * A `start()` that appeared to succeed turns out to have failed asynchronously (today:
   * only the element strategy's `play()` promise rejecting, most often because the browser
   * required its own user gesture, e.g. iOS Safari). By the time this fires the engine has
   * already reported "playing" with nothing actually audible; correct that the same way
   * `ctx.resume()` rejecting already does, rather than leaving silence unexplained.
   */
  private handleStartError(error: unknown): void {
    this.stopRaf();
    this._paused = true;
    this.setState("paused");
    this.emitter.emit("error", {
      error: new EkoError(
        "autoplay_blocked",
        "eko-web: the browser blocked playback. Call play() from a user gesture.",
        { cause: error },
      ),
    });
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

  /**
   * Reset the current source's own gain back to its steady `normGain`, cancelling any
   * crossfade automation still scheduled on it. `current` is what pause() and seek()
   * restart rather than replace, and a crossfade schedules a real ramp on its gain as the
   * outgoing side of a boundary; that automation is on the AudioParam itself, independent
   * of whether the armed track it paired with is still around (clearArmed() only disposes
   * that other side). Left alone, a later restart plays back through whatever level the
   * ramp left the node at, partway down or pinned at silence, instead of the track's own
   * level. This is unrelated to fadeGain's own click-removal ramp on the shared node,
   * which startSource() still handles on its own.
   *
   * `when` defers the pin to the end of a fade already in flight, so the level the
   * listener is still hearing is not stepped back up underneath that fade; see
   * clearArmed(), which is the only caller that has one.
   */
  private pinCurrentGain(when?: number): void {
    const gain = this.current?.gain;
    if (!gain || !this.ctx) return;
    const at = when ?? this.ctx.currentTime;
    gain.gain.cancelScheduledValues(at);
    gain.gain.setValueAtTime(this.current!.normGain, at);
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
