/**
 * The A-707's INPUT selector. TAPE is the deck as it is. PHONO plays the deck as a record:
 * the top rolled off on the deck path, crackle and rumble from the extras path. TUNER is a
 * radio parked between stations, and AUX is a lead with nothing on the end of it.
 */
import { glide } from "./amp-chain.js";
import { crackle, loopSource, pinkNoise, seeded } from "./noise.js";

export const INPUTS = ["phono", "tuner", "aux", "tape"];
export const INPUT_LABELS = { phono: "Phono", tuner: "Tuner", aux: "Aux", tape: "Tape" };

/** The deck path's share of the selector: plain inserts between the deck and the amp. */
export function createInputStage(ctx) {
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 22000;
  const gate = ctx.createGain();
  return {
    nodes: [tone, gate],
    set(input) {
      const deckHeard = input === "tape" || input === "phono";
      glide(ctx, gate.gain, deckHeard ? 1 : 0, 0.02);
      glide(ctx, tone.frequency, input === "phono" ? 9000 : 22000);
    },
  };
}

/** What the other inputs make on their own: these keep sounding while the deck is paused. */
export function createExtras(ctx) {
  const output = ctx.createGain();
  const rand = seeded(23);

  // TUNER: band-limited static whose level breathes, a heterodyne whistle that wanders,
  // and now and then a distant station drifting in.
  const staticSrc = loopSource(ctx, pinkNoise(ctx.sampleRate * 4, seeded(5)));
  const staticTone = ctx.createBiquadFilter();
  staticTone.type = "bandpass";
  staticTone.frequency.value = 2200;
  staticTone.Q.value = 0.4;
  const staticGain = ctx.createGain();
  staticGain.gain.value = 0;
  staticSrc.connect(staticTone);
  staticTone.connect(staticGain);
  staticGain.connect(output);

  const whistle = ctx.createOscillator();
  whistle.frequency.value = 2400;
  const whistleGain = ctx.createGain();
  whistleGain.gain.value = 0;
  whistle.connect(whistleGain);
  whistleGain.connect(output);

  const stationTone = ctx.createBiquadFilter();
  stationTone.type = "bandpass";
  stationTone.frequency.value = 1100;
  stationTone.Q.value = 0.6;
  const stationGain = ctx.createGain();
  stationGain.gain.value = 0;
  stationTone.connect(stationGain);
  stationGain.connect(output);

  // AUX: 50 Hz mains hum with its odd harmonics, from an unshielded lead.
  const hum = ctx.createOscillator();
  hum.type = "square";
  hum.frequency.value = 50;
  const humTone = ctx.createBiquadFilter();
  humTone.type = "lowpass";
  humTone.frequency.value = 320;
  const humGain = ctx.createGain();
  humGain.gain.value = 0;
  hum.connect(humTone);
  humTone.connect(humGain);
  humGain.connect(output);

  // PHONO: surface crackle and turntable rumble, only while the record (the deck) turns.
  const crackleSrc = loopSource(ctx, crackle(ctx.sampleRate * 7, ctx.sampleRate));
  const rumbleSrc = loopSource(ctx, pinkNoise(ctx.sampleRate * 3, seeded(9)));
  const rumbleTone = ctx.createBiquadFilter();
  rumbleTone.type = "lowpass";
  rumbleTone.frequency.value = 40;
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  crackleSrc.connect(crackleGain);
  rumbleSrc.connect(rumbleTone);
  rumbleTone.connect(rumbleGain);
  crackleGain.connect(output);
  rumbleGain.connect(output);

  for (const src of [staticSrc, whistle, hum, crackleSrc, rumbleSrc]) src.start();

  let input = "tape";
  let deckRunning = false;
  let station = null;
  let swell = 0;
  let swellTarget = 0;
  let nextChange = 0;
  let clock = 0;

  function apply() {
    glide(ctx, humGain.gain, input === "aux" ? 0.012 : 0, 0.05);
    const record = input === "phono" && deckRunning;
    glide(ctx, crackleGain.gain, record ? 0.35 : 0, 0.05);
    glide(ctx, rumbleGain.gain, record ? 0.08 : 0, 0.2);
    if (input !== "tuner") {
      glide(ctx, staticGain.gain, 0, 0.05);
      glide(ctx, whistleGain.gain, 0, 0.05);
      glide(ctx, stationGain.gain, 0, 0.05);
    }
  }

  return {
    output,
    set(nextInput, running) {
      input = nextInput;
      deckRunning = running;
      apply();
    },
    /** A looping buffer for the distant station (the demo loop, decoded). */
    setStation(buffer) {
      if (station) return;
      station = ctx.createBufferSource();
      station.buffer = buffer;
      station.loop = true;
      station.playbackRate.value = 0.997;
      station.connect(stationTone);
      station.start();
    },
    /** Drift the radio a little each frame. */
    tick(dt) {
      if (input !== "tuner") return;
      clock += dt;
      if (clock >= nextChange) {
        nextChange = clock + 1.5 + rand() * 4;
        // Mostly lost between stations; about a third of the time something comes through.
        swellTarget = rand() < 0.35 ? 0.5 + rand() * 0.5 : rand() * 0.15;
        glide(ctx, whistle.frequency, 900 + rand() * 4200, 0.8);
      }
      swell += (swellTarget - swell) * Math.min(1, dt * 0.8);
      const flicker = 0.85 + rand() * 0.15;
      glide(ctx, staticGain.gain, (0.8 - swell * 0.55) * flicker, 0.05);
      glide(ctx, whistleGain.gain, 0.02 * (1 - swell), 0.2);
      glide(ctx, stationGain.gain, station ? swell * 1.4 : 0, 0.1);
    },
  };
}
