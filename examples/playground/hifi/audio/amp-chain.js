/**
 * The G-110 and A-707 as one Web Audio sub-graph, handed to engine.setInserts() as a
 * composite { input, output } stage. Nothing here is rewired after it is built: every
 * switch moves a gain, a frequency or a delay, so changes are click-free.
 *
 *   input -> 10 EQ bands -> bass, treble -> loudness -> LOW, HIGH filters
 *         -> mono and balance matrix -> speaker voicing -> phones crossfeed
 *         -> tape monitor echo -> master -> output
 */
import { BANDS } from "./meters.js";
import { balanceGains, dbToGain, loudnessDb, volumeDb } from "./taper.js";

export const SETTINGS = {
  power: true,
  eqPower: true,
  eqDefeat: false,
  bands: Array(10).fill(0),
  volume: 6,
  bass: 0,
  treble: 0,
  balance: 0,
  loud: false,
  low: false,
  high: false,
  mono: false,
  speakers: "A",
  phones: false,
  tapeMon: "off",
};

export const SPEAKERS = ["A", "A+B", "B"];
/** B is a pair of small bookshelf boxes: no deep bass, a forward midrange, a soft top. */
export const SPEAKER_VOICING = {
  A: { hp: 10, lp: 22000, mid: 0 },
  "A+B": { hp: 45, lp: 12000, mid: 1.5 },
  B: { hp: 140, lp: 6500, mid: 3 },
};

export const TAPE_MON = ["off", "short", "long", "dub"];
/** Monitoring off the playback head of an imaginary echo deck: delay, feedback, wet level. */
export const ECHO = {
  off: { time: 0.11, feedback: 0, wet: 0 },
  short: { time: 0.11, feedback: 0.15, wet: 0.35 },
  long: { time: 0.32, feedback: 0.35, wet: 0.35 },
  dub: { time: 0.42, feedback: 0.6, wet: 0.45 },
};

export const EQ_RANGE = 12;
export const TONE_RANGE = 10;
const LOW_CUT_HZ = 60;
const HIGH_CUT_HZ = 7000;
const OPEN_LOW_HZ = 5;
const OPEN_HIGH_HZ = 22000;

/** Move a parameter smoothly from wherever it is. */
export function glide(ctx, param, value, tau = 0.012) {
  if (param.setTargetAtTime) param.setTargetAtTime(value, ctx.currentTime, tau);
  else param.value = value;
}

/** A gain that upmixes mono to both channels, so the splitters below always see stereo. */
function stereoGain(ctx) {
  const g = ctx.createGain();
  g.channelCount = 2;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

function filter(ctx, type, frequency, Q = 0.707, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}

function gain(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** outL = ll*L + rl*R, outR = lr*L + rr*R. Mono and balance are both just this matrix. */
function matrix(ctx, input) {
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  input.connect(split);
  const g = { ll: gain(ctx, 1), rl: gain(ctx, 0), lr: gain(ctx, 0), rr: gain(ctx, 1) };
  split.connect(g.ll, 0);
  split.connect(g.lr, 0);
  split.connect(g.rl, 1);
  split.connect(g.rr, 1);
  g.ll.connect(merge, 0, 0);
  g.rl.connect(merge, 0, 0);
  g.lr.connect(merge, 0, 1);
  g.rr.connect(merge, 0, 1);
  return { output: merge, gains: g };
}

/**
 * Headphone crossfeed (after Bauer): each ear also hears the other channel, low-passed and
 * a fraction of a millisecond late, the way speakers in a room would deliver it.
 */
function crossfeed(ctx, input) {
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  input.connect(split);
  const direct = [gain(ctx, 1), gain(ctx, 1)];
  const cross = [gain(ctx, 0), gain(ctx, 0)];
  for (const ch of [0, 1]) {
    split.connect(direct[ch], ch);
    direct[ch].connect(merge, 0, ch);
    const lp = filter(ctx, "lowpass", 700);
    const delay = ctx.createDelay(0.01);
    delay.delayTime.value = 0.0003;
    split.connect(lp, ch);
    lp.connect(delay);
    delay.connect(cross[ch]);
    cross[ch].connect(merge, 0, 1 - ch);
  }
  return { output: merge, direct, cross };
}

/** A dry path plus a delay line feeding itself through a dark tape-ish filter. */
function echo(ctx, input) {
  const out = ctx.createGain();
  const dry = gain(ctx, 1);
  const delay = ctx.createDelay(1);
  delay.delayTime.value = ECHO.off.time;
  const tone = filter(ctx, "lowpass", 3500);
  const feedback = gain(ctx, 0);
  const wet = gain(ctx, 0);
  input.connect(dry);
  dry.connect(out);
  input.connect(delay);
  delay.connect(tone);
  tone.connect(feedback);
  feedback.connect(delay);
  tone.connect(wet);
  wet.connect(out);
  return { output: out, delay, feedback, wet };
}

export function createAmpChain(ctx) {
  const input = stereoGain(ctx);
  const bands = BANDS.map((f) => filter(ctx, "peaking", f, 1.2));
  const bass = filter(ctx, "lowshelf", 100);
  const treble = filter(ctx, "highshelf", 10000);
  const loudLow = filter(ctx, "lowshelf", 60);
  const loudHigh = filter(ctx, "highshelf", 12000);
  const lowCut = filter(ctx, "highpass", OPEN_LOW_HZ);
  const highCut = filter(ctx, "lowpass", OPEN_HIGH_HZ);
  const spkHp = filter(ctx, "highpass", SPEAKER_VOICING.A.hp, 0.9);
  const spkLp = filter(ctx, "lowpass", SPEAKER_VOICING.A.lp);
  const spkMid = filter(ctx, "peaking", 1800, 0.8);

  const serial = [input, ...bands, bass, treble, loudLow, loudHigh, lowCut, highCut];
  for (let i = 1; i < serial.length; i++) serial[i - 1].connect(serial[i]);
  const mat = matrix(ctx, highCut);
  mat.output.connect(spkHp);
  spkHp.connect(spkLp);
  spkLp.connect(spkMid);
  const phones = crossfeed(ctx, spkMid);
  const mon = echo(ctx, phones.output);
  const master = gain(ctx, 0);
  mon.output.connect(master);
  const output = ctx.createGain();
  master.connect(output);

  let relayOpen = true;

  function set(s) {
    const eqLive = s.eqPower && !s.eqDefeat;
    bands.forEach((b, i) => glide(ctx, b.gain, eqLive ? clamp(s.bands[i], EQ_RANGE) : 0));
    glide(ctx, bass.gain, clamp(s.bass, TONE_RANGE));
    glide(ctx, treble.gain, clamp(s.treble, TONE_RANGE));
    const atten = volumeDb(s.volume);
    const loud = s.loud ? loudnessDb(atten) : { low: 0, high: 0 };
    glide(ctx, loudLow.gain, loud.low);
    glide(ctx, loudHigh.gain, loud.high);
    glide(ctx, lowCut.frequency, s.low ? LOW_CUT_HZ : OPEN_LOW_HZ);
    glide(ctx, highCut.frequency, s.high ? HIGH_CUT_HZ : OPEN_HIGH_HZ);

    const { left, right } = balanceGains(s.balance);
    const m = s.mono ? 0.5 : 0;
    glide(ctx, mat.gains.ll.gain, (1 - m) * left);
    glide(ctx, mat.gains.rl.gain, m * left);
    glide(ctx, mat.gains.lr.gain, m * right);
    glide(ctx, mat.gains.rr.gain, (1 - m) * right);

    const v = SPEAKER_VOICING[s.speakers] ?? SPEAKER_VOICING.A;
    glide(ctx, spkHp.frequency, v.hp);
    glide(ctx, spkLp.frequency, v.lp);
    glide(ctx, spkMid.gain, v.mid);

    for (const ch of [0, 1]) {
      glide(ctx, phones.direct[ch].gain, s.phones ? 0.8 : 1);
      glide(ctx, phones.cross[ch].gain, s.phones ? 0.45 : 0);
    }

    const e = ECHO[s.tapeMon] ?? ECHO.off;
    glide(ctx, mon.delay.delayTime, e.time, 0.05);
    glide(ctx, mon.feedback.gain, e.feedback);
    glide(ctx, mon.wet.gain, e.wet);

    glide(ctx, master.gain, s.power && relayOpen ? dbToGain(atten) : 0, 0.03);
  }

  return {
    input,
    output,
    set,
    /** The protection relay: closed while the amp settles after power on. */
    setRelay(open, s) {
      relayOpen = open;
      set(s);
    },
    /** For tests: the nodes whose settings set() drives. */
    parts: {
      bands,
      bass,
      treble,
      loudLow,
      loudHigh,
      lowCut,
      highCut,
      mat,
      spkHp,
      spkLp,
      spkMid,
      phones,
      mon,
      master,
    },
  };
}

const clamp = (v, range) => Math.max(-range, Math.min(range, v));
