import { describe, it, expect } from "vitest";
import { EkoQueue } from "../src/queue/queue";
import type { EkoTrack } from "../src/types";

const tracks = (n: number): EkoTrack[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), src: `/t${i}.flac` }));

function make(n: number) {
  const q = new EkoQueue();
  q.setTracks(tracks(n));
  return q;
}

describe("EkoQueue sequential", () => {
  it("starts on the first track", () => {
    const q = make(3);
    expect(q.currentIndex).toBe(0);
    expect(q.current?.id).toBe("0");
    expect(q.length).toBe(3);
  });

  it("peeks the next track without consuming it", () => {
    const q = make(3);
    expect(q.peekNext()?.id).toBe("1");
    expect(q.peekNext()?.id).toBe("1");
    expect(q.currentIndex).toBe(0);
  });

  it("advances in order and ends at the last track", () => {
    const q = make(3);
    expect(q.advance()?.id).toBe("1");
    expect(q.advance()?.id).toBe("2");
    expect(q.peekNext()).toBeNull();
    expect(q.advance()).toBeNull();
    expect(q.currentIndex).toBe(2);
  });

  it("an empty queue has no current and nothing next", () => {
    const q = new EkoQueue();
    q.setTracks([]);
    expect(q.current).toBeNull();
    expect(q.currentIndex).toBe(-1);
    expect(q.peekNext()).toBeNull();
    expect(q.advance()).toBeNull();
  });

  it("honours a start index", () => {
    const q = new EkoQueue();
    q.setTracks(tracks(4), 2);
    expect(q.currentIndex).toBe(2);
    expect(q.peekNext()?.id).toBe("3");
  });
});

describe("EkoQueue repeat", () => {
  it('repeat "all" wraps past the end', () => {
    const q = make(3);
    q.repeat = "all";
    q.jumpTo(2);
    expect(q.peekNext()?.id).toBe("0");
    expect(q.advance()?.id).toBe("0");
  });

  it('repeat "one" peeks and advances to the same track', () => {
    const q = make(3);
    q.repeat = "one";
    q.jumpTo(1);
    expect(q.peekNext()?.id).toBe("1");
    expect(q.advance()?.id).toBe("1");
    expect(q.currentIndex).toBe(1);
  });

  it('repeat "none" stops at the end', () => {
    const q = make(2);
    q.jumpTo(1);
    expect(q.peekNext()).toBeNull();
  });

  it('peekNextIndex(true) ignores repeat "one" and reports the real next index', () => {
    const q = make(3);
    q.repeat = "one";
    q.jumpTo(1);
    expect(q.peekNextIndex()).toBe(1); // the boundary: loops on itself
    expect(q.peekNextIndex(true)).toBe(2); // manual Next: the real next track
  });

  it('advance(true) under repeat "one" moves forward instead of looping', () => {
    const q = make(3);
    q.repeat = "one";
    q.jumpTo(1);
    expect(q.advance(true)?.id).toBe("2");
    expect(q.currentIndex).toBe(2);
  });
});

describe("EkoQueue shuffle", () => {
  it("draws every track once before repeating any", () => {
    const q = make(8);
    q.shuffle = true;
    const seen = [q.currentIndex];
    for (let i = 0; i < 7; i++) {
      const next = q.advance();
      expect(next).not.toBeNull();
      seen.push(q.currentIndex);
    }
    expect(new Set(seen).size).toBe(8);
  });

  it("peek matches the track advance actually moves to, every time", () => {
    const q = make(10);
    q.shuffle = true;
    for (let i = 0; i < 9; i++) {
      const peeked = q.peekNext();
      const advanced = q.advance();
      expect(advanced).toEqual(peeked);
    }
  });

  it("peek is stable across repeated calls", () => {
    const q = make(10);
    q.shuffle = true;
    const first = q.peekNext();
    expect(q.peekNext()).toEqual(first);
    expect(q.peekNext()).toEqual(first);
  });

  it('a shuffled bag that empties ends playback under repeat "none"', () => {
    const q = make(3);
    q.shuffle = true;
    q.advance();
    q.advance();
    expect(q.peekNext()).toBeNull();
    expect(q.advance()).toBeNull();
  });

  it('a shuffled bag refills under repeat "all"', () => {
    const q = make(3);
    q.shuffle = true;
    q.repeat = "all";
    q.advance();
    q.advance();
    expect(q.peekNext()).not.toBeNull();
    expect(q.advance()).not.toBeNull();
  });

  it('a two track shuffled bag keeps refilling under repeat "all"', () => {
    // Two is the smallest queue where the bag genuinely empties and refills, rather than
    // being forced empty by excluding the only track there is.
    const q = make(2);
    q.shuffle = true;
    q.repeat = "all";
    const seen = new Set([q.currentIndex]);
    for (let i = 0; i < 4; i++) {
      const next = q.advance();
      expect(next).not.toBeNull();
      seen.add(q.currentIndex);
    }
    expect(seen).toEqual(new Set([0, 1]));
  });

  it('a single track loops on itself under shuffle plus repeat "all"', () => {
    const q = make(1);
    q.shuffle = true;
    q.repeat = "all";
    expect(q.peekNext()?.id).toBe("0");
    expect(q.advance()?.id).toBe("0");
    expect(q.peekNext()?.id).toBe("0");
    expect(q.advance()?.id).toBe("0");
  });

  it('a single track under shuffle has nowhere to go without repeat "all"', () => {
    const q = make(1);
    q.shuffle = true;
    expect(q.peekNext()).toBeNull();
    expect(q.advance()).toBeNull();
  });

  it('setting repeat to "all" after a shuffled bag has drained under repeat "none" revives it', () => {
    const q = make(4);
    q.shuffle = true;
    q.advance();
    q.advance();
    q.advance();
    // Bag is now empty: repeat "none" has nothing left to offer.
    expect(q.peekNext()).toBeNull();
    q.repeat = "all";
    // Flipping to "all" over an empty bag must refill it immediately, or the queue can
    // never recover: nothing else touches the bag from here.
    expect(q.peekNextIndex()).not.toBe(-1);
    expect(q.advance()).not.toBeNull();
  });

  it("turning shuffle off returns to sequential order from where it is", () => {
    const q = make(5);
    q.shuffle = true;
    q.advance();
    q.shuffle = false;
    const here = q.currentIndex;
    const expected = here + 1 < 5 ? String(here + 1) : null;
    // `?? null` matters: `?.id` on a null track is undefined, which never equals null.
    expect(q.peekNext()?.id ?? null).toBe(expected);
  });
});

describe("EkoQueue history", () => {
  it("previous retraces what was actually played, not the index below", () => {
    const q = make(6);
    q.shuffle = true;
    const played = [q.currentIndex];
    q.advance();
    played.push(q.currentIndex);
    q.advance();
    played.push(q.currentIndex);

    expect(q.previous()?.id).toBe(String(played[1]));
    expect(q.previous()?.id).toBe(String(played[0]));
  });

  it("previous falls back to the index below when there is no history", () => {
    const q = make(3);
    q.jumpTo(2);
    expect(q.previous()?.id).toBe("1");
  });

  it("previous at the very start returns null", () => {
    const q = make(3);
    expect(q.previous()).toBeNull();
  });
});

describe("EkoQueue stepBack", () => {
  it("walking forward three tracks under shuffle then back three times retraces exactly what was heard", () => {
    const q = make(8);
    q.shuffle = true;
    const played = [q.currentIndex];
    q.advance();
    played.push(q.currentIndex);
    q.advance();
    played.push(q.currentIndex);
    q.advance();
    played.push(q.currentIndex);

    expect(q.stepBack()).toBe(played[2]);
    expect(q.stepBack()).toBe(played[1]);
    expect(q.stepBack()).toBe(played[0]);
  });

  it("falls back to the index below when there is no history", () => {
    const q = make(3);
    q.jumpTo(2);
    expect(q.stepBack()).toBe(1);
  });

  it("at the very start returns -1", () => {
    const q = make(3);
    expect(q.stepBack()).toBe(-1);
  });

  it("stepping back and then advancing again redraws the same track, not a fresh one", () => {
    // stepBack() puts the index it is leaving back on the FRONT of the bag rather than
    // rebuilding the pool, so the pass survives: the very next draw is that same track.
    const q = make(8);
    q.shuffle = true;
    q.advance();
    q.advance();
    const beforeBack = q.currentIndex;
    q.stepBack();
    expect(q.advance()?.id).toBe(String(beforeBack));
  });

  it("previous() preserves the pass the same way, having delegated to stepBack()", () => {
    const q = make(8);
    q.shuffle = true;
    q.advance();
    q.advance();
    const beforeBack = q.currentIndex;
    q.previous();
    expect(q.advance()?.id).toBe(String(beforeBack));
  });

  it("jumpTo removes the destination from the bag instead of rebuilding the whole pool", () => {
    const q = make(8);
    q.shuffle = true;
    const seen = [q.currentIndex];
    q.advance();
    seen.push(q.currentIndex);
    q.advance();
    seen.push(q.currentIndex);
    // The bag's own next candidate: guaranteed to still be sitting in the bag.
    const target = Number(q.peekNext()!.id);
    q.jumpTo(target);
    seen.push(q.currentIndex);
    // Four tracks are now accounted for (start, two advances, the jump). Walking the
    // remaining four must complete the pass without repeating any of those four: a rebuild
    // (rather than removing just the jumped-to entry) would put them back in contention.
    for (let i = 0; i < 4; i++) {
      q.advance();
      seen.push(q.currentIndex);
    }
    expect(new Set(seen).size).toBe(8);
  });
});

describe("EkoQueue setTracks", () => {
  it("resets history and the bag", () => {
    const q = make(5);
    q.shuffle = true;
    q.advance();
    q.advance();
    q.setTracks(tracks(3));
    expect(q.currentIndex).toBe(0);
    expect(q.previous()).toBeNull();
  });
});

describe("EkoQueue restoreTo", () => {
  it("undoes a failed forward move (advance) without losing the history entry it pushed", () => {
    const q = make(4);
    q.advance(); // 0 -> 1, history [0]
    const historyDepth = q.historyLength;
    q.advance(); // 1 -> 2 (the move that will be "undone"), history [0, 1]
    q.restoreTo(1, historyDepth, 2);
    expect(q.currentIndex).toBe(1);
    // The push made by the undone advance() must be gone, or a following previous() lands
    // back on 1 (where it already is) instead of 0.
    expect(q.previous()?.id).toBe("0");
  });

  it("undoes a failed backward move (stepBack) by restoring the entry it popped", () => {
    const q = make(4);
    q.advance(); // 0 -> 1, history [0]
    q.advance(); // 1 -> 2, history [0, 1]
    const historyDepth = q.historyLength;
    const target = q.stepBack(); // pops 1, history [0], index 1
    expect(target).toBe(1);
    q.restoreTo(2, historyDepth, target);
    expect(q.currentIndex).toBe(2);
    // The pop must be undone, or the next stepBack() skips past 1 straight to 0.
    expect(q.stepBack()).toBe(1);
    expect(q.stepBack()).toBe(0);
  });
});
