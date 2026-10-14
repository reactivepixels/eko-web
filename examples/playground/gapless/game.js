/** The blind test itself: who is behind each key, what you guessed, and the score. */

export const ROUND_COUNT = 10;

/**
 * @param {number} count
 * @param {() => number} rand
 */
export function createGame(count = ROUND_COUNT, rand = Math.random) {
  return {
    count,
    index: 0,
    /** Which key EKO is behind, decided fresh for every round. */
    eko: Array.from({ length: count }, () => (rand() < 0.5 ? "A" : "B")),
    /** null until guessed, then true or false. */
    results: Array(count).fill(null),
    streak: 0,
    bestStreak: 0,
    /** Which keys have been heard this round: you must hear both before guessing. */
    heard: { A: false, B: false },
  };
}

export const canGuess = (g) => g.heard.A && g.heard.B && g.results[g.index] === null;
export const revealed = (g) => g.results[g.index] !== null;
export const finished = (g) => g.results.every((r) => r !== null);
export const correctCount = (g) => g.results.filter((r) => r === true).length;
export const playedCount = (g) => g.results.filter((r) => r !== null).length;

/** The other key: the bare tag. */
export const tagSide = (g) => (g.eko[g.index] === "A" ? "B" : "A");

export function hear(g, side) {
  g.heard[side] = true;
  return g;
}

/** Record a guess. Returns whether it was right, or null if a guess is not allowed now. */
export function guess(g, side) {
  if (!canGuess(g)) return null;
  const right = g.eko[g.index] === side;
  g.results[g.index] = right;
  g.streak = right ? g.streak + 1 : 0;
  g.bestStreak = Math.max(g.bestStreak, g.streak);
  return right;
}

/** On to the next round. Returns false at the end of the game. */
export function advance(g) {
  if (g.index >= g.count - 1) return false;
  g.index += 1;
  g.heard = { A: false, B: false };
  return true;
}

/** A one-line verdict for the end screen. */
export function verdict(correct, count) {
  const ratio = correct / count;
  if (ratio >= 0.9) return "Golden ears. You hear the gap every time.";
  if (ratio >= 0.7) return "You can hear it. Most people can, once they listen for it.";
  if (ratio > 0.4) return "Coin-flip territory. Try headphones and listen right at the seam.";
  return "Contrarian ears: you kept picking the gap.";
}
