/**
 * Minimal Web Audio mocks so the engine can be unit-tested in Node (no jsdom).
 * Loosely typed; cast to the real types at the injection boundary in tests.
 */

export class MockParam {
  value = 1;
  scheduled: Array<{ value: number; time: number }> = [];
  /** Linear ramps, in the order they were scheduled. */
  ramps: Array<{ value: number; time: number }> = [];
  setValueAtTime(value: number, time: number): this {
    this.scheduled.push({ value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.ramps.push({ value, time });
    return this;
  }
  cancelScheduledValues(_time: number): this {
    this.scheduled = [];
    this.ramps = [];
    return this;
  }
}

export class MockGainNode {
  gain = new MockParam();
  /** Everything this node is currently connected to, in connect order. */
  connections: unknown[] = [];
  connect(destination?: unknown): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.connections = [];
  }
}

export class MockAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  connections: unknown[] = [];
  connect(destination?: unknown): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.connections = [];
  }
  getByteFrequencyData(_array: Uint8Array): void {}
}

export class MockBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  startWhen = 0;
  startOffset = 0;
  stopWhen: number | null = null;
  /** Everything this node is currently connected to, in connect order. */
  connections: unknown[] = [];
  connect(destination?: unknown): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.connections = [];
  }
  start(when = 0, offset = 0): void {
    this.started = true;
    this.startWhen = when;
    this.startOffset = offset;
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stopWhen = when ?? null;
  }
  /** Test helper: simulate the buffer reaching its natural end. */
  fireEnded(): void {
    this.onended?.();
  }
}

export class MockAudioBuffer {
  constructor(
    public numberOfChannels: number,
    private data: Float32Array[],
    public sampleRate: number,
  ) {}
  get length(): number {
    return this.data[0]?.length ?? 0;
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c] ?? new Float32Array(0);
  }
}

export class MockAudioContext {
  state: "suspended" | "running" | "closed" = "running";
  currentTime = 0;
  destination = {};
  /** Every gain node created, in order: [rgGain, fadeGain, userGain]. */
  gains: MockGainNode[] = [];
  /** Every buffer source created. */
  sources: MockBufferSource[] = [];
  /** The buffer the next decodeAudioData resolves to. */
  nextBuffer: MockAudioBuffer | null = null;
  /** Every analyser created. Empty until something touches `graph.analyser`. */
  analysers: MockAnalyserNode[] = [];

  createGain(): MockGainNode {
    const g = new MockGainNode();
    this.gains.push(g);
    return g;
  }
  createAnalyser(): MockAnalyserNode {
    const a = new MockAnalyserNode();
    this.analysers.push(a);
    return a;
  }
  createBufferSource(): MockBufferSource {
    const s = new MockBufferSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(_arr: ArrayBuffer): Promise<MockAudioBuffer> {
    if (!this.nextBuffer) throw new Error("mock: no nextBuffer set");
    return this.nextBuffer;
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

/** A 1 kHz sine AudioBuffer for loudness/normalization tests. */
export function makeToneBuffer(
  amplitude: number,
  seconds = 0.5,
  sampleRate = 48000,
): MockAudioBuffer {
  const n = Math.floor(seconds * sampleRate);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  return new MockAudioBuffer(1, [ch], sampleRate);
}

/** Install a fetch stub that returns OK (or a given status). Returns a restore fn. */
export function stubFetch(ok = true, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as unknown as Response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
