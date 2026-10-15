/**
 * The rhythm composer's clock and patterns. Steps are sixteenth notes; swing delays every
 * second one. Everything here is pure: the page asks which steps fall inside the next
 * slice of time and schedules them on the AudioContext clock, so timing never depends on
 * when a JavaScript timer happens to fire.
 */

export const STEPS = 16;
export const PHRASE_BARS = 8;
export const VOICES = ["bd", "cp", "ch", "oh", "bl"];
export const VOICE_NAMES = {
  bd: "Bass drum",
  cp: "Hand clap",
  ch: "Closed hat",
  oh: "Open hat",
  bl: "Bass line",
};
/** Notes the bass line cycles through, as semitones above A1. */
export const BASS_NOTES = ["A", "C", "D", "E", "G"];
const SEMITONES = { A: 0, C: 3, D: 5, E: 7, G: 10 };

export const stepSeconds = (bpm) => 60 / bpm / 4;
export const barSeconds = (bpm) => (60 / bpm) * 4;
export const phraseSeconds = (bpm) => barSeconds(bpm) * PHRASE_BARS;

/** Swing (0 to 0.6) pushes every off-beat sixteenth later by that share of a step. */
export function stepTime(origin, index, bpm, swing = 0) {
  const d = stepSeconds(bpm);
  return origin + index * d + (index % 2 === 1 ? swing * d : 0);
}

/**
 * Every step whose time falls in [from, to), counted from `origin`. Returns { index, step,
 * time }: `index` counts from the start, `step` is its position in the 16-step bar.
 */
export function stepsBetween(origin, from, to, bpm, swing = 0) {
  const d = stepSeconds(bpm);
  const out = [];
  let i = Math.max(0, Math.floor((from - origin) / d) - 1);
  for (; ; i++) {
    const t = stepTime(origin, i, bpm, swing);
    if (t >= to) break;
    if (t >= from) out.push({ index: i, step: i % STEPS, time: t });
  }
  return out;
}

/** The next phrase boundary at or after `time`, at least `margin` seconds away. */
export function nextPhrase(origin, time, bpm, margin = 0) {
  const p = phraseSeconds(bpm);
  const n = Math.max(0, Math.ceil((time + margin - origin) / p));
  return origin + n * p;
}

const row = (s) => [...s].map((c) => (c === "." ? null : c === "x" ? true : c));

/**
 * Four patterns. A is the Night Bus groove: four on the floor, eighth-note hats, and the
 * bass line from the record (A A C D E D C G, one note per eighth).
 */
export const PATTERNS = {
  A: {
    bd: row("x...x...x...x..."),
    cp: row("....x.......x..."),
    ch: row("x.x.x.x.x.x.x.x."),
    oh: row("..x...x...x...x."),
    bl: row("A.A.C.D.E.D.C.G."),
  },
  B: {
    bd: row("x...x...x...x.x."),
    cp: row("....x.......x..x"),
    ch: row("xxxxxxxxxxxxxxxx"),
    oh: row("..x...x...x...x."),
    bl: row("A..AC..DE..DC.G."),
  },
  C: {
    bd: row("x..x..x...x..x.."),
    cp: row("....x.......x..."),
    ch: row("x.xxx.xxx.xxx.x."),
    oh: row("......x.......x."),
    bl: row("A...A...E...G..."),
  },
  D: {
    bd: row("x..............x"),
    cp: row("................"),
    ch: row("..x...x...x...x."),
    oh: row("x...x...x...x..."),
    bl: row("A.......C......."),
  },
};

export function clonePattern(p) {
  return Object.fromEntries(VOICES.map((v) => [v, [...p[v]].slice(0, STEPS)]));
}

/** Pressing a step: drums toggle; the bass line cycles off, A, C, D, E, G, off. */
export function pressStep(pattern, voice, step) {
  const cur = pattern[voice][step];
  if (voice !== "bl") {
    pattern[voice][step] = cur ? null : true;
  } else {
    const at = cur ? BASS_NOTES.indexOf(cur) : -1;
    pattern[voice][step] = at + 1 < BASS_NOTES.length ? BASS_NOTES[at + 1] : null;
  }
  return pattern[voice][step];
}

/** Frequency of a bass-line note, an octave around A1 (55 Hz). */
export const bassHz = (note) => 55 * Math.pow(2, (SEMITONES[note] ?? 0) / 12);
