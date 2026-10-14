/**
 * Just enough of an AudioContext for the graph tests: nodes record their connections, and
 * params record the value they were last told to glide to.
 */
const param = (value = 0) => ({
  value,
  setTargetAtTime(v) {
    this.value = v;
  },
});

function node(kind, fields = {}) {
  return {
    kind,
    connections: [],
    connect(target, output = 0, input = 0) {
      this.connections.push({ target, output, input });
      return target;
    },
    disconnect() {
      this.connections = [];
    },
    start() {
      this.started = true;
    },
    ...fields,
  };
}

export function fakeContext() {
  const created = [];
  const make = (kind, fields) => {
    const n = node(kind, fields);
    created.push(n);
    return n;
  };
  return {
    created,
    currentTime: 0,
    sampleRate: 8000,
    destination: make("destination"),
    createGain: () => make("gain", { gain: param(1) }),
    createBiquadFilter: () =>
      make("biquad", { type: "lowpass", frequency: param(350), Q: param(1), gain: param(0) }),
    createDelay: () => make("delay", { delayTime: param(0) }),
    createChannelSplitter: () => make("splitter"),
    createChannelMerger: () => make("merger"),
    createWaveShaper: () => make("shaper", { curve: null }),
    createOscillator: () => make("osc", { type: "sine", frequency: param(440) }),
    createBufferSource: () => make("buffersource", { playbackRate: param(1), loop: false }),
    createBuffer: (channels, length) => {
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    },
  };
}

/** Every node reachable from `from` by following connections. */
export function reachable(from) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    for (const c of n.connections || []) walk(c.target);
  };
  walk(from);
  return seen;
}
