/**
 * Records exactly what a player sends out, sample by sample, with an AudioWorklet
 * (capture-worklet.js). The reveal measures the seam from this capture: the gap you see is
 * the gap that played.
 */

const loaded = new WeakMap();

/** The processor is a real file next to this one, so no blob: URL or CSP exception is needed. */
function ensureModule(ctx) {
  if (!loaded.has(ctx)) {
    const p = ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
    // A failed load must not stick: let the next press try again.
    p.catch(() => loaded.delete(ctx));
    loaded.set(ctx, p);
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
  // Every stop() gets an answer, in order, even if a second one arrives before the first
  // "done" comes back from the audio thread.
  const waiting = [];
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
      waiting.shift()?.(out);
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
        waiting.push(resolve);
        node.port.postMessage("stop");
      });
    },
  };
}
