/**
 * The rhythm composer's voices, synthesized on the spot like the analogue boxes they are
 * modelled on: nothing is sampled. Each call schedules one hit at an exact context time
 * into the channel strip it belongs to.
 */
import { pinkNoise, seeded } from "../../hifi/audio/noise.js";

export const KIT = { bdTune: 0, bdDecay: 0.5, hatDecay: 0.5 };
export const BASS = { cutoff: 0.45, reso: 0.35, decay: 0.4 };

export function createVoices(ctx) {
  // One shared noise buffer: claps and hats are filtered noise, retriggered.
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  noise.getChannelData(0).set(pinkNoise(ctx.sampleRate, seeded(31)).map((v) => v * 2.2));
  let openHat = null;

  const env = (param, t, peak, decay, start = 0) => {
    param.cancelScheduledValues(t);
    param.setValueAtTime(start, t);
    param.linearRampToValueAtTime(peak, t + 0.002);
    param.exponentialRampToValueAtTime(0.0001, t + decay);
  };
  const noiseHit = (t, out, { type, freq, q, gain, decay, offset = 0 }) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    // A separate stage for chokes, so silencing a hit never disturbs its own envelope.
    const choke = ctx.createGain();
    src.connect(f).connect(g).connect(choke).connect(out);
    env(g.gain, t, gain, decay);
    src.start(t, offset);
    src.stop(t + decay + 0.05);
    return { src, choke };
  };

  return {
    /** A sine thump with a fast pitch sweep: the 808 recipe. */
    kick(t, out, kit = KIT) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      const base = 46 * Math.pow(2, kit.bdTune / 12);
      o.frequency.setValueAtTime(base * 3.2, t);
      o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
      o.connect(g).connect(out);
      const decay = 0.18 + kit.bdDecay * 0.6;
      env(g.gain, t, 1, decay);
      o.start(t);
      o.stop(t + decay + 0.05);
    },
    /** Three quick noise bursts and a tail: hands that do not quite clap together. */
    clap(t, out) {
      for (const [dt, gain] of [
        [0, 0.55],
        [0.011, 0.5],
        [0.023, 0.45],
      ]) {
        noiseHit(t + dt, out, { type: "bandpass", freq: 1200, q: 1.1, gain, decay: 0.03 });
      }
      noiseHit(t + 0.03, out, { type: "bandpass", freq: 1100, q: 0.9, gain: 0.35, decay: 0.22 });
    },
    hat(t, out, open, kit = KIT) {
      // An open hat is choked by the next closed one, as on the real machines.
      if (openHat) {
        openHat.choke.gain.setValueAtTime(1, t);
        openHat.choke.gain.setTargetAtTime(0, t, 0.006);
        openHat = null;
      }
      const decay = open ? 0.18 + kit.hatDecay * 0.5 : 0.025 + kit.hatDecay * 0.06;
      const hit = noiseHit(t, out, {
        type: "highpass",
        freq: 7500,
        q: 0.7,
        gain: open ? 0.35 : 0.42,
        decay,
        offset: Math.random() * 0.5,
      });
      if (open) openHat = hit;
    },
    /** A monophonic saw through a resonant low-pass with its own envelope. */
    bass(t, hz, dur, out, p = BASS) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = hz;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.Q.value = 0.7 + p.reso * 14;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(f).connect(g).connect(out);
      const top = 180 + p.cutoff * 2600;
      const d = 0.08 + p.decay * 0.5;
      f.frequency.setValueAtTime(top, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(60, top * 0.18), t + d);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.004);
      g.gain.setTargetAtTime(0.32, t + 0.01, d * 0.6);
      g.gain.setTargetAtTime(0, t + Math.max(0.05, dur - 0.02), 0.012);
      o.start(t);
      o.stop(t + dur + 0.1);
    },
  };
}
