/** Generated noises: tape hiss, radio static, record crackle and mains hum all start here. */

/** A small seeded generator, so the noises are the same on every load (and in tests). */
export function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Pink noise (Paul Kellet's filter), peaking near +/-1. */
export function pinkNoise(length, rand = seeded(7)) {
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/**
 * Record surface noise: sparse clicks of random size, each a few samples of decaying
 * noise, plus the occasional bigger pop. About `perSecond` clicks a second.
 */
export function crackle(length, sampleRate, perSecond = 9, rand = seeded(11)) {
  const out = new Float32Array(length);
  const count = Math.round((length / sampleRate) * perSecond);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(rand() * length);
    const pop = rand() < 0.06;
    const amp = (pop ? 0.5 : 0.08 + rand() * 0.22) * (rand() < 0.5 ? -1 : 1);
    const len = pop ? 90 : 6 + Math.floor(rand() * 24);
    for (let i = 0; i < len && at + i < length; i++) {
      out[at + i] += amp * Math.exp(-i / (len / 4)) * (0.6 + rand() * 0.4);
    }
  }
  return out;
}

/**
 * A soft saturation curve for a WaveShaper: tanh scaled to unity gain at low level, so the
 * tape only rounds off the peaks instead of making everything louder.
 */
export function saturationCurve(drive, size = 2048) {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / drive;
  }
  return curve;
}

/** Put a generated mono signal in an AudioBuffer and loop it from a source node. */
export function loopSource(ctx, samples) {
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}
