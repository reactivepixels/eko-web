/**
 * The Night Bus stems: arpeggio, pad, drone and crowd, rendered as exact eight-bar loops at
 * the console's tempo. Each loop is rendered a bar long and folded, so the tail of the last
 * bar (ringing notes, echoes of the crowd) lands on the first and the loop has no seam.
 */
import { normalize, seeded, STYLES, wavBlob } from "../../shared/synth.js";
import { barSeconds, PHRASE_BARS } from "./sequencer.js";

export const STEM_RATE = 44100;

export const STEMS = [
  { id: "arp", name: "Arp", style: "arpeggio", root: 57, level: 0.5 },
  { id: "pad", name: "Pad", style: "pad", root: 57, level: 0.45 },
  { id: "drone", name: "Drone", style: "drone", root: 45, level: 0.4 },
  { id: "crowd", name: "Crowd", style: "crowd", root: 57, level: 0.35 },
];

/** Add the overhang past `length` back onto the start, so the loop wraps cleanly. */
export function foldLoop(samples, length) {
  const out = samples.slice(0, length);
  for (let i = length; i < samples.length; i++) out[i - length] += samples[i];
  return out;
}

export function renderStem(stem, bpm, rate = STEM_RATE) {
  const length = Math.round(barSeconds(bpm) * PHRASE_BARS * rate);
  const tail = Math.round(barSeconds(bpm) * rate);
  const buf = new Float32Array(length + tail);
  STYLES[stem.style](buf, rate, { root: stem.root, bpm, rand: seeded(stem.root * 7 + bpm) });
  // Fade the overhang out over its bar, so what wraps is a decay rather than a cut.
  for (let i = 0; i < tail; i++) buf[length + i] *= 1 - i / tail;
  return normalize(foldLoop(buf, length), stem.level);
}

/** Each stem as a WAV object URL, ready for an engine's queue. */
export function stemUrls(bpm) {
  return STEMS.map((stem) => URL.createObjectURL(wavBlob([renderStem(stem, bpm)], STEM_RATE)));
}
