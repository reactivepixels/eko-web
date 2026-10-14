/**
 * Runs on the audio thread: while recording, posts every render quantum it hears as one
 * mono block. A quantum with no input connected is posted as silence, so the recording
 * keeps time even while nothing plays.
 */
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => {
      this.on = e.data === "start";
      if (!this.on) this.port.postMessage("done");
    };
  }

  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const mono = new Float32Array(128);
    if (input.length) {
      const n = input[0].length;
      for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("eko-capture", Capture);
