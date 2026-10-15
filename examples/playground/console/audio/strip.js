/**
 * Channel strips, the master section and the tape echo, as Web Audio graphs.
 *
 *   input -> trim -> lo / mid / hi EQ -> pan -> fader -> mute gate -> master bus
 *                                    `-> echo send (post-fader, from before the gate)
 *
 * Stems arrive at a strip's input from an EKO engine (its `destination` option); the
 * drum machine's voices are scheduled straight into theirs.
 */

export const STRIP = {
  trim: 0,
  hi: 0,
  mid: 0,
  lo: 0,
  echo: 0,
  pan: 0,
  fader: 0.75,
  mute: false,
  solo: false,
};

/** Fader position (0..1) to gain: a long-throw console law, 0.75 is unity, top is +10 dB. */
export function faderGain(pos) {
  if (pos <= 0) return 0;
  const db = pos >= 0.75 ? ((pos - 0.75) / 0.25) * 10 : -60 + (pos / 0.75) * 60;
  return Math.pow(10, Math.max(-60, db) / 20);
}

/** The dB a fader position reads, for its label and tests. */
export function faderDb(pos) {
  const g = faderGain(pos);
  return g === 0 ? -Infinity : 20 * Math.log10(g);
}

const glide = (ctx, param, v, tau = 0.015) => {
  if (param.setTargetAtTime) param.setTargetAtTime(v, ctx.currentTime, tau);
  else param.value = v;
};

function biquad(ctx, type, freq, q = 0.8) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function createStrip(ctx, master, echoBus) {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";
  const trim = ctx.createGain();
  const lo = biquad(ctx, "lowshelf", 120);
  const mid = biquad(ctx, "peaking", 1200, 0.9);
  const hi = biquad(ctx, "highshelf", 8000);
  const pan = ctx.createStereoPanner();
  const fader = ctx.createGain();
  const gate = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = 0;
  input
    .connect(trim)
    .connect(lo)
    .connect(mid)
    .connect(hi)
    .connect(pan)
    .connect(fader)
    .connect(gate);
  gate.connect(master);
  gate.connect(send);
  send.connect(echoBus);
  // The strip's meter reads what it sends to the master.
  const meter = ctx.createAnalyser();
  meter.fftSize = 512;
  gate.connect(meter);

  return {
    input,
    meter,
    parts: { trim, lo, mid, hi, pan, fader, gate, send },
    /** `audible` folds mute and the console's solo state together. */
    set(s, audible) {
      glide(ctx, trim.gain, Math.pow(10, s.trim / 20));
      glide(ctx, lo.gain, s.lo);
      glide(ctx, mid.gain, s.mid);
      glide(ctx, hi.gain, s.hi);
      glide(ctx, pan.pan, s.pan);
      glide(ctx, fader.gain, faderGain(s.fader));
      glide(ctx, gate.gain, audible ? 1 : 0, 0.008);
      glide(ctx, send.gain, s.echo);
    },
  };
}

/** Whether each channel is heard: mute always silences; any solo silences the rest. */
export function audibility(strips) {
  const anySolo = strips.some((s) => s.solo);
  return strips.map((s) => !s.mute && (!anySolo || s.solo));
}

export const ECHO = { time: 0.5, repeat: 0.35, tone: 0.5, ret: 0.6, sync: true };

/** A tape echo: the delay wobbles a little, and each repeat comes back darker. */
export function createEcho(ctx, master) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(2);
  const tone = biquad(ctx, "lowpass", 3000, 0.5);
  const hp = biquad(ctx, "highpass", 120, 0.5);
  const feedback = ctx.createGain();
  const ret = ctx.createGain();
  const wow = ctx.createOscillator();
  wow.frequency.value = 0.7;
  const wowDepth = ctx.createGain();
  wowDepth.gain.value = 0.0012;
  wow.connect(wowDepth).connect(delay.delayTime);
  wow.start();
  input.connect(delay).connect(tone).connect(hp);
  hp.connect(feedback).connect(delay);
  hp.connect(ret).connect(master);
  return {
    input,
    /** `beat` is one beat in seconds: SYNC locks the delay to a dotted eighth. */
    set(e, beat) {
      const time = e.sync ? beat * 0.75 : 0.05 + e.time * 0.75;
      glide(ctx, delay.delayTime, Math.min(1.9, time), 0.08);
      glide(ctx, feedback.gain, e.repeat * 0.85);
      glide(ctx, tone.frequency, 800 + e.tone * 5200);
      glide(ctx, ret.gain, e.ret);
    },
  };
}

export function createMaster(ctx) {
  const bus = ctx.createGain();
  const fader = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  // A gentle safety limiter: eight channels and an echo can add up past full scale.
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  bus.connect(fader).connect(limiter).connect(ctx.destination);
  const split = ctx.createChannelSplitter(2);
  limiter.connect(split);
  const vu = [0, 1].map((ch) => {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    split.connect(a, ch);
    return a;
  });
  return {
    bus,
    vu,
    set(pos) {
      glide(ctx, fader.gain, faderGain(pos));
    },
  };
}
