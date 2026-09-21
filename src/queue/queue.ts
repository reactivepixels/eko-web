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
 * empties, so `peekNext()` is only ever a read.
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
    this._repeat = mode;
  }

  /** The index that follows the current one, or -1 when nothing does. Never mutates. */
  peekNextIndex(): number {
    if (this.index < 0 || this.tracks.length === 0) return -1;
    if (this._repeat === "one") return this.index;
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

  /** Move to the next track and return it, or null when the queue is finished. */
  advance(): EkoTrack | null {
    const next = this.peekNextIndex();
    if (next < 0) return null;
    if (next !== this.index) this.history.push(this.index);
    if (this._shuffle && this._repeat !== "one") {
      this.bag.shift();
      // Refill the moment it empties, so peekNextIndex never has to.
      if (this.bag.length === 0 && this._repeat === "all") this.refillBag(next);
    }
    this.index = next;
    return this.current;
  }

  /**
   * Step back through what was actually played. Under shuffle that is the only correct
   * answer: the index below the current one was probably never heard.
   */
  previous(): EkoTrack | null {
    const fromHistory = this.history.pop();
    if (fromHistory !== undefined) {
      this.index = fromHistory;
      return this.current;
    }
    if (this.index > 0) {
      this.index -= 1;
      return this.current;
    }
    return null;
  }

  /** Step back one entry in history. Returns the index moved to, or -1 when there is none. */
  stepBack(): number {
    const last = this.history.pop();
    if (last !== undefined) {
      this.index = last;
      this.refillBag(last);
      return last;
    }
    if (this.index > 0) {
      this.index -= 1;
      this.refillBag(this.index);
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
    this.refillBag(index);
    return this.current;
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
}
