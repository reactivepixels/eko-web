/**
 * Winamp's 10-band EQ as real Web Audio nodes, handed to engine.setInserts(). The panner
 * stays in the chain even with the EQ off, because balance is an insert too: the engine has
 * volume but no balance of its own.
 */

export const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

/** Winamp 2.x's shipped presets, in dB. */
export const PRESETS = {
  Flat: { preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  Rock: { preamp: 0, bands: [5, 3, -3, -5, -2, 3, 6, 7, 7, 7] },
  Pop: { preamp: 0, bands: [-1, 3, 5, 5, 3, -1, -2, -2, -1, -1] },
  Dance: { preamp: 0, bands: [6, 4, 1, 0, 0, -3, -4, -4, 0, 0] },
  Classical: { preamp: 0, bands: [0, 0, 0, 0, 0, 0, -5, -5, -5, -7] },
};

const clampDb = (db) => Math.max(-12, Math.min(12, db));
export const dbToGain = (db) => Math.pow(10, db / 20);

/** @param {BaseAudioContext} ctx */
export function createEqChain(ctx) {
  const preamp = ctx.createGain();
  const filters = EQ_FREQS.map((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
    f.frequency.value = freq;
    f.Q.value = 1.4;
    f.gain.value = 0;
    return f;
  });
  const panner = ctx.createStereoPanner();
  let on = true;
  let preampDb = 0;

  const chain = {
    /** The insert list for engine.setInserts(). It changes with setOn(), so rewire then. */
    nodes: () => (on ? [preamp, ...filters, panner] : [panner]),
    setOn(value) {
      on = value;
    },
    isOn: () => on,
    setPreamp(db) {
      preampDb = clampDb(db);
      preamp.gain.value = dbToGain(preampDb);
    },
    setBand(i, db) {
      filters[i].gain.value = clampDb(db);
    },
    setBalance(pan) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
    },
    applyPreset(name) {
      const p = PRESETS[name];
      if (!p) return;
      chain.setPreamp(p.preamp);
      p.bands.forEach((db, i) => chain.setBand(i, db));
    },
    state: () => ({ on, preamp: preampDb, bands: filters.map((f) => f.gain.value) }),
  };
  return chain;
}
