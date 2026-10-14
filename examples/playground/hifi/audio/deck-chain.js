/**
 * The D-55's playback path, a composite insert ahead of the amp. With DOLBY NR in (the
 * default) it is a straight wire. Out, the tape type sets how much of the format you hear:
 * hiss, a soft saturation, a rolled-off top, and wow and flutter from a wobbling delay.
 */
import { glide } from "./amp-chain.js";
import { loopSource, pinkNoise, saturationCurve } from "./noise.js";

export const TAPE_TYPES = ["normal", "cro2", "metal"];
export const TAPE_LABELS = { normal: "Normal", cro2: "CrO2", metal: "Metal" };

/** Ferric is the hissiest and softest; metal the cleanest. */
export const TAPE_CHARACTER = {
  normal: { hiss: 0.006, drive: 1.3, top: 11000, wow: 0.0011, flutter: 0.00014 },
  cro2: { hiss: 0.0035, drive: 1.0, top: 14000, wow: 0.0008, flutter: 0.0001 },
  metal: { hiss: 0.002, drive: 0.75, top: 17000, wow: 0.0006, flutter: 0.00008 },
};

/** Nominal delay the wow and flutter swing around, in seconds. */
const BASE_DELAY = 0.006;

export function createDeckChain(ctx) {
  const input = ctx.createGain();
  // Everything meets here before the output: the deck's own level meters tap this, since
  // the engine owns the output's connections.
  const sum = ctx.createGain();
  sum.channelCount = 2;
  sum.channelCountMode = "explicit";
  sum.channelInterpretation = "speakers";
  const output = ctx.createGain();
  sum.connect(output);
  const dry = ctx.createGain();
  input.connect(dry);
  dry.connect(sum);

  const shaper = ctx.createWaveShaper();
  shaper.oversample = "2x";
  const wobble = ctx.createDelay(0.05);
  wobble.delayTime.value = BASE_DELAY;
  const top = ctx.createBiquadFilter();
  top.type = "lowpass";
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(shaper);
  shaper.connect(wobble);
  wobble.connect(top);
  top.connect(wet);
  wet.connect(sum);

  // Wow is the slow capstan drift, flutter the fast one; both just swing the delay time.
  const wowOsc = ctx.createOscillator();
  wowOsc.frequency.value = 0.55;
  const wowDepth = ctx.createGain();
  wowDepth.gain.value = 0;
  const flutterOsc = ctx.createOscillator();
  flutterOsc.frequency.value = 7.5;
  const flutterDepth = ctx.createGain();
  flutterDepth.gain.value = 0;
  wowOsc.connect(wowDepth);
  wowDepth.connect(wobble.delayTime);
  flutterOsc.connect(flutterDepth);
  flutterDepth.connect(wobble.delayTime);

  const hissSrc = loopSource(ctx, pinkNoise(ctx.sampleRate * 3));
  const hissTone = ctx.createBiquadFilter();
  hissTone.type = "highpass";
  hissTone.frequency.value = 2500;
  const hiss = ctx.createGain();
  hiss.gain.value = 0;
  hissSrc.connect(hissTone);
  hissTone.connect(hiss);
  hiss.connect(sum);

  wowOsc.start();
  flutterOsc.start();
  hissSrc.start();

  let lastType = null;

  /** @param {{ dolby: boolean, tapeType: string }} s */
  function set(s) {
    const c = TAPE_CHARACTER[s.tapeType] ?? TAPE_CHARACTER.normal;
    if (s.tapeType !== lastType) {
      shaper.curve = saturationCurve(c.drive);
      lastType = s.tapeType;
    }
    const raw = !s.dolby;
    glide(ctx, dry.gain, raw ? 0 : 1, 0.03);
    glide(ctx, wet.gain, raw ? 1 : 0, 0.03);
    glide(ctx, hiss.gain, raw ? c.hiss : 0, 0.03);
    glide(ctx, top.frequency, c.top);
    glide(ctx, wowDepth.gain, raw ? c.wow : 0, 0.05);
    glide(ctx, flutterDepth.gain, raw ? c.flutter : 0, 0.05);
  }

  return { input, output, tap: sum, set };
}
