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
