/**
 * Records exactly what a player sends out, sample by sample, with an AudioWorklet. The
 * reveal measures the seam from this capture: the gap you see is the gap that played.
 */

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = e.data === "start"; if (!this.on) this.port.postMessage("done"); };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input.length) {
      const n = input[0].length;
      const mono = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    } else if (this.on) {
      // No input connected this quantum: the player is silent.
      this.port.postMessage(new Float32Array(128));
    }
    return true;
  }
}
registerProcessor("eko-capture", Capture);
`;

const loaded = new WeakMap();

async function ensureModule(ctx) {
  if (!loaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    loaded.set(
      ctx,
      ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)),
    );
  }
  return loaded.get(ctx);
}

/**
 * A capture point. Connect a player into `input`; `start()` begins recording and `stop()`
 * resolves with everything since, as one mono Float32Array at the context's rate.
 */
export async function createCapture(ctx) {
  await ensureModule(ctx);
  const node = new AudioWorkletNode(ctx, "eko-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  // The worklet must be pulled by the graph to run, so it feeds a silent gain.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);

  let chunks = [];
  let finish = null;
  node.port.onmessage = (e) => {
    if (e.data === "done") {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      chunks = [];
      finish?.(out);
      finish = null;
    } else {
      chunks.push(e.data);
    }
  };

  return {
    input: node,
    start() {
      chunks = [];
      node.port.postMessage("start");
    },
    stop() {
      return new Promise((resolve) => {
        finish = resolve;
        node.port.postMessage("stop");
      });
    },
  };
}
