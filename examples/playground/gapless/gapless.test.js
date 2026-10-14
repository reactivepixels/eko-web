import { describe, expect, it } from "vitest";
import { CLIP_RATE, HALF, renderRound, ROUNDS, splitAt, wavBlob } from "./audio/clips.js";
import {
  columns,
  contentStart,
  findGap,
  formatSamples,
  MIN_GAP,
  measureSeam,
} from "./audio/seam.js";
import {
  advance,
  canGuess,
  correctCount,
  createGame,
  finished,
  guess,
  hear,
  tagSide,
  verdict,
} from "./game.js";

const RATE = 8000;

describe("clips", () => {
  it("renders every round at full length, under full scale, never silent at the seam", () => {
    ROUNDS.forEach((_, i) => {
      const s = renderRound(i, RATE);
      expect(s.length).toBe(RATE * HALF * 2);
      const peak = Math.max(...s.map(Math.abs));
      expect(peak).toBeCloseTo(0.707, 2);
      // Within 5 ms either side of the cut there is always something playing.
      const mid = RATE * HALF;
      const near = s.subarray(mid - 40, mid + 40);
      expect(Math.max(...near.map(Math.abs))).toBeGreaterThan(0.001);
      // And the music itself has no gap anywhere.
      expect(findGap(s).length).toBe(0);
    });
  });

  it("is the same on every render", () => {
    expect(renderRound(3, RATE)).toEqual(renderRound(3, RATE));
  });

  it("writes WAV headers for the channel count and rate", async () => {
    const blob = wavBlob([new Float32Array(10), new Float32Array(10)], CLIP_RATE);
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(44 + 10 * 2 * 2);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(CLIP_RATE);
  });

  it("splits into halves that add back up to the whole", () => {
    const [a, b] = splitAt([new Float32Array(100)], RATE, 37);
    expect(a.size - 44 + (b.size - 44)).toBe(200);
    expect(a.size).toBe(44 + 37 * 2);
  });
});

describe("seam measurement", () => {
  const tone = (n, from = 0) =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((i + from) * 0.07) + 0.3);

  it("ignores silence before and after the music", () => {
    const s = new Float32Array(1000);
    s.set(tone(600), 200);
    expect(contentStart(s)).toBe(200);
    expect(findGap(s).length).toBe(0);
  });

  it("finds a gap inside the music", () => {
    const s = new Float32Array(2000);
    s.set(tone(500), 100);
    s.set(tone(800), 100 + 500 + 333);
    expect(findGap(s)).toEqual({ start: 600, length: 333 });
  });

  it("does not mistake a zero crossing for a gap", () => {
    const s = tone(1000);
    s.fill(0, 400, 400 + MIN_GAP - 1);
    expect(findGap(s).length).toBe(0);
  });

  it("puts a seamless seam where the second file began", () => {
    const s = new Float32Array(RATE * 7);
    s.set(tone(RATE * 6), 50);
    expect(measureSeam(s, RATE, 3)).toEqual({ at: 50 + RATE * 3, samples: 0, ms: 0, valid: true });
  });

  it("reports a gap at the seam in samples and milliseconds", () => {
    const s = new Float32Array(RATE * 8);
    s.set(tone(RATE * 3), 10);
    s.set(tone(RATE * 3), 10 + RATE * 3 + 400);
    expect(measureSeam(s, RATE, 3)).toEqual({
      at: 10 + RATE * 3,
      samples: 400,
      ms: 50,
      valid: true,
    });
  });

  it("ignores quiet far from the seam, such as a player starting late", () => {
    const s = new Float32Array(RATE * 9);
    s.set(tone(200), 0);
    s.set(tone(RATE * 6), RATE);
    const m = measureSeam(s, RATE, 3);
    expect(m.samples).toBe(0);
    expect(m.valid).toBe(true);
  });

  it("only counts silence beyond what the music already has", () => {
    const s = new Float32Array(RATE * 8);
    s.set(tone(RATE * 3), 0);
    s.set(tone(RATE * 3), RATE * 3 + 300);
    expect(measureSeam(s, RATE, 3, 300).samples).toBe(0);
    expect(measureSeam(s, RATE, 3, 100).samples).toBe(200);
  });

  it("will not report 0 for a capture that recorded nothing", () => {
    expect(measureSeam(new Float32Array(RATE * 7), RATE, 3).valid).toBe(false);
    expect(measureSeam(tone(RATE), RATE, 3).valid).toBe(false);
  });

  it("takes peak columns and groups thousands", () => {
    expect([...columns(Float32Array.from([0.1, -0.9, 0.2, 0.3]), 0, 4, 2)]).toEqual([
      expect.closeTo(0.9),
      expect.closeTo(0.3),
    ]);
    expect(formatSamples(7938)).toBe("7 938");
    expect(formatSamples(162812)).toBe("162 812");
  });
});

describe("game", () => {
  const coin = (...flips) => {
    let i = 0;
    return () => flips[i++ % flips.length];
  };

  it("hides EKO behind a random key each round", () => {
    const g = createGame(4, coin(0.1, 0.9));
    expect(g.eko).toEqual(["A", "B", "A", "B"]);
    expect(tagSide(g)).toBe("B");
  });

  it("only takes a guess after both keys have been heard, and only once", () => {
    const g = createGame(2, coin(0.1));
    expect(guess(g, "A")).toBeNull();
    hear(g, "A");
    expect(canGuess(g)).toBe(false);
    hear(g, "B");
    expect(guess(g, "A")).toBe(true);
    expect(guess(g, "B")).toBeNull();
  });

  it("keeps score, streak and best streak", () => {
    const g = createGame(3, coin(0.1));
    for (const side of ["A", "A", "B"]) {
      hear(hear(g, "A"), "B");
      guess(g, side);
      advance(g);
    }
    expect(correctCount(g)).toBe(2);
    expect(g.streak).toBe(0);
    expect(g.bestStreak).toBe(2);
    expect(finished(g)).toBe(true);
    expect(advance(g)).toBe(false);
  });

  it("resets what has been heard for each new round", () => {
    const g = createGame(2);
    hear(hear(g, "A"), "B");
    advance(g);
    expect(g.heard).toEqual({ A: false, B: false });
  });

  it("has something to say about any score", () => {
    for (let c = 0; c <= 10; c++) expect(verdict(c, 10).length).toBeGreaterThan(10);
  });
});
