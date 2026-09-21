import type { EkoTrack } from "../types";

export type RepeatMode = "none" | "one" | "all";

/**
 * Track ordering, and nothing else. No audio, no time, no engine.
 *
 * This lives in the library rather than the consuming app because gapless arms the next
 * track during the current one, so the scheduler has to ask "what plays next" before the
 * boundary. An app-owned queue either swaps tracks on `ended`, which defeats gapless, or
 * reaches into the prefetch, which is a de-facto API anyway.
 *
 * Two properties the scheduler depends on, and which shape the whole design:
 *
 * - `peekNext()` never mutates. It must not draw from the shuffle bag.
 * - `peekNext()` is stable: called twice with no state change in between, it answers the
 *   same. If the armed track and the advanced-to track disagree, the wrong song plays.
 *
 * Both fall out of keeping the bag already refilled: `advance()` refills it the moment it
 * empties under repeat "all", and the `repeat` setter tops it up too when a switch INTO
 * "all" is itself what makes the bag relevant again, so `peekNext()` is only ever a read.
 */
export class EkoQueue {
  private tracks: EkoTrack[] = [];
  private index = -1;
  /** Indices not yet drawn in this shuffle pass, in the order they will be drawn. */
  private bag: number[] = [];
  /** Indices actually played, most recent last. Drives `previous()`. */
  private history: number[] = [];
  private _shuffle = false;
  private _repeat: RepeatMode = "none";

  setTracks(tracks: EkoTrack[], startIndex = 0): void {
    this.tracks = tracks.slice();
    this.index = tracks.length > 0 ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1;
    this.history = [];
    this.refillBag();
  }

  get current(): EkoTrack | null {
    return this.tracks[this.index] ?? null;
  }

  get currentIndex(): number {
    return this.index;
  }

  get length(): number {
    return this.tracks.length;
  }

  get shuffle(): boolean {
    return this._shuffle;
  }

  set shuffle(on: boolean) {
    if (this._shuffle === on) return;
    this._shuffle = on;
    // A fresh pass either way: turning shuffle on should not inherit a sequential position
    // as a drawn card, and turning it off should not leave a stale bag behind.
    this.refillBag();
  }

  get repeat(): RepeatMode {
    return this._repeat;
  }

  set repeat(mode: RepeatMode) {
    // Switching INTO "all" over an empty shuffle bag is the one other moment (besides
    // advance() itself) that makes the bag relevant again: with repeat "none" or "one" an
    // empty bag is a dead end by design, but "all" promises the queue keeps going, and
    // nothing else will ever refill it once it is set. Conditioned on the bag actually
    // being empty, so a mid-pass flip does not reset the pass and replay tracks already
    // drawn in it.
    if (mode === "all" && this._shuffle && this.bag.length === 0) this.refillBag();
    this._repeat = mode;
  }

  /**
   * The index that follows the current one, or -1 when nothing does. Never mutates.
   *
   * `ignoreRepeatOne`, when true, answers as if repeat were not "one": the real next track
   * in sequence or in the bag, rather than the current track looping on itself. A manual
   * "next" press wants that answer even under repeat "one" (looping is a boundary
   * behaviour, not something the Next button should do); the automatic boundary itself
   * still wants the default.
   */
  peekNextIndex(ignoreRepeatOne = false): number {
    if (this.index < 0 || this.tracks.length === 0) return -1;
    if (this._repeat === "one" && !ignoreRepeatOne) return this.index;
    if (this._shuffle) {
      const next = this.bag[0];
      if (next !== undefined) return next;
      // The bag reads empty here only for a single track queue: with two or more, advance()
      // refills it the moment it empties, so peekNextIndex never observes an empty bag. A
      // lone track under repeat "all" has nowhere to go but back to itself, the same wrap
      // the sequential branch below already gives it.
      return this._repeat === "all" && this.tracks.length === 1 ? this.index : -1;
    }
    const next = this.index + 1;
    if (next < this.tracks.length) return next;
    return this._repeat === "all" ? 0 : -1;
  }

  peekNext(): EkoTrack | null {
    const next = this.peekNextIndex();
    return next < 0 ? null : (this.tracks[next] ?? null);
  }

  /** Move to the next track and return it, or null when the queue is finished. See
   * `peekNextIndex` for what `ignoreRepeatOne` means; a manual next() passes true. */
  advance(ignoreRepeatOne = false): EkoTrack | null {
    const next = this.peekNextIndex(ignoreRepeatOne);
    if (next < 0) return null;
    if (next !== this.index) this.history.push(this.index);
    // Looping on the current track under repeat "one" must not touch the bag: nothing was
    // actually drawn. Ignoring repeat "one" (a manual next()) means a real draw happened
    // even though repeat is "one", so it shifts the bag same as any other advance.
    const loopedOnRepeatOne = this._repeat === "one" && !ignoreRepeatOne;
    if (this._shuffle && !loopedOnRepeatOne) {
      this.bag.shift();
      // Refill the moment it empties, so peekNextIndex never has to.
      if (this.bag.length === 0 && this._repeat === "all") this.refillBag(next);
    }
    this.index = next;
    return this.current;
  }

  /**
   * Step back through what was actually played, and return the track. Under shuffle that
   * is the only correct answer: the index below the current one was probably never heard.
   * A thin wrapper: `stepBack()` holds the one implementation, this just resolves its
   * result to a track.
   */
  previous(): EkoTrack | null {
    const target = this.stepBack();
    return target < 0 ? null : this.current;
  }

  /**
   * Step back one entry in history, or one sequential index when there is none. Returns
   * the index moved to, or -1 when there is nowhere to go.
   *
   * Under shuffle, the index being left has probably not been heard yet in this pass (it
   * was just arrived at going forward, or is the queue's starting point), so it goes back
   * onto the FRONT of the bag rather than triggering a full rebuild: a rebuild would
   * forget every other track already drawn in this pass, and hand some of them back out
   * again before the rest of the pass has played. Putting it on the front also means
   * stepping back and then immediately forward again retraces the same track, which is
   * the behaviour a listener bouncing Previous/Next expects.
   */
  stepBack(): number {
    const last = this.history.pop();
    if (last !== undefined) {
      if (this._shuffle) this.bag.unshift(this.index);
      this.index = last;
      return last;
    }
    if (this.index > 0) {
      if (this._shuffle) this.bag.unshift(this.index);
      this.index -= 1;
      return this.index;
    }
    return -1;
  }

  /**
   * Jump straight to an index, as a manual skip or a fresh queue position does. This does
   * not extend `previous()` history: a deliberate jump is not "what was actually played"
   * on the way there, so a bare jump leaves `previous()` to fall back to the index below.
   * That means `previous()` after a manual jump does not undo the jump: history records
   * what the queue's own advance walked through, not every value the index has held. Same
   * reason `setTracks` clears history rather than seeding it.
   */
  jumpTo(index: number): EkoTrack | null {
    if (index < 0 || index >= this.tracks.length) return null;
    this.index = index;
    // Same reasoning as stepBack(): only retire the one index actually landed on, rather
    // than rebuilding the whole pool and forgetting the rest of the pass.
    this.removeFromBag(index);
    return this.current;
  }

  /**
   * Undo a move that already changed both the index and history, such as `skipTo()`'s
   * rollback after a failed load: `next()`/`previous()` move the queue eagerly, before the
   * load starts, so a failure has to put both back.
   *
   * `historyDepth` is `history.length` captured before the move. A move that pushed
   * (`advance()`, behind a manual `next()`) grew history past that depth, so undoing it
   * means truncating back down; no value is needed, the entry is simply dropped. A move
   * that popped (`stepBack()`, behind `previous()`) shrank it below that depth, so undoing
   * it means pushing `poppedValue` back on. The caller always already has that value: it
   * is exactly the target `stepBack()` moved to, since `stepBack()` sets the index to
   * whatever it pops.
   */
  restoreTo(index: number, historyDepth: number, poppedValue: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    if (this.history.length > historyDepth) {
      this.history.length = historyDepth;
    } else if (this.history.length < historyDepth) {
      this.history.push(poppedValue);
    }
    this.index = index;
    // The index being restored to is current again, so it must not also be sitting in the
    // bag waiting to be drawn (the move being undone may have put it there, directly or by
    // way of a refill).
    this.removeFromBag(index);
  }

  /** How many entries `previous()`/`stepBack()` have to walk back through. */
  get historyLength(): number {
    return this.history.length;
  }

  /** Every index except `exclude`, shuffled when shuffle is on, in order when it is off. */
  private refillBag(exclude = this.index): void {
    const pool: number[] = [];
    for (let i = 0; i < this.tracks.length; i++) if (i !== exclude) pool.push(i);
    if (this._shuffle) {
      // Fisher-Yates, so every ordering is equally likely.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const a = pool[i]!;
        pool[i] = pool[j]!;
        pool[j] = a;
      }
    }
    this.bag = pool;
  }

  /** Drop `index` from the bag if it is sitting in there, without disturbing the rest. */
  private removeFromBag(index: number): void {
    if (!this._shuffle) return;
    const pos = this.bag.indexOf(index);
    if (pos >= 0) this.bag.splice(pos, 1);
  }
}
