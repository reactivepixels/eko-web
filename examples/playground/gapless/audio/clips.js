/**
 * The test material. Each round is one continuous piece of music, cut in two at its exact
 * middle: the first file ends mid-note and the second picks up on the very next sample. Any
 * gap between them is the player's, never the music's, and there is no encoder padding to
 * blame because both halves are plain WAV.
 */

import { normalize, seeded, STYLES } from "../../shared/synth.js";

export { splitAt, wavBlob } from "../../shared/synth.js";

export const CLIP_RATE = 44100;
/** Seconds either side of the seam. */
export const HALF = 3;

/** Ten rounds: five textures, each twice in a different key and tempo. */
export const ROUNDS = [
  { style: "pad", root: 57, bpm: 90, from: "03 Low Tide", to: "04 Salt Lines", side: "Side A" },
  {
    style: "arpeggio",
    root: 62,
    bpm: 112,
    from: "01 Morning Glass",
    to: "02 Relay",
    side: "Side A",
  },
  {
    style: "crowd",
    root: 55,
    bpm: 100,
    from: "06 Harbour Lights",
    to: "07 Encore",
    side: "Side B, live",
  },
  { style: "groove", root: 45, bpm: 118, from: "02 Night Bus", to: "03 Terminus", side: "Side A" },
  { style: "drone", root: 50, bpm: 60, from: "05 Long Wave", to: "06 Carrier", side: "Side B" },
  {
    style: "arpeggio",
    root: 57,
    bpm: 132,
    from: "08 Mirrorball",
    to: "09 Afterhours",
    side: "Side B",
  },
  {
    style: "pad",
    root: 60,
    bpm: 80,
    from: "04 Salt Lines",
    to: "05 Undertow",
    side: "Side B, live",
  },
  { style: "groove", root: 40, bpm: 96, from: "10 Slow Burn", to: "11 Embers", side: "Side B" },
  {
    style: "crowd",
    root: 52,
    bpm: 100,
    from: "12 Thank You",
    to: "13 One More",
    side: "Side C, live",
  },
  { style: "drone", root: 47, bpm: 60, from: "01 Overture", to: "02 Threshold", side: "Side A" },
];

/** Render a round as one continuous mono signal, 2 x HALF seconds, peak-normalized to -3 dBFS. */
export function renderRound(index, rate = CLIP_RATE) {
  const round = ROUNDS[index % ROUNDS.length];
  const out = new Float32Array(rate * HALF * 2);
  STYLES[round.style](out, rate, { ...round, rand: seeded(index * 977 + 13) });
  return normalize(out);
}
