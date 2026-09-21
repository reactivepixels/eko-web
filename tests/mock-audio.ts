/**
 * Minimal Web Audio mocks so the engine can be unit-tested in Node (no jsdom).
 * Loosely typed; cast to the real types at the injection boundary in tests.
 */

export class MockParam {
  value = 1;
  scheduled: Array<{ value: number; time: number }> = [];
  /** Linear ramps, in the order they were scheduled. */
  ramps: Array<{ value: number; time: number }> = [];
  /** The value before any automation event — what `valueAt` holds before the first event. */
  private readonly initialValue: number;

  constructor(initialValue = 1) {
    this.value = initialValue;
    this.initialValue = initialValue;
  }

  setValueAtTime(value: number, time: number): this {
    this.scheduled.push({ value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.ramps.push({ value, time });
    // A real AudioParam's `.value` getter reflects the live, computed automation value,
    // which settles at a ramp's target once the ramp completes. `rampTo()` reads `.value`
    // to pin the ramp's own starting point, so this has to track the ramp target too, not
    // just an explicit `setValueAtTime` call, or that pin silently reads a stale value.
    this.value = value;
    return this;
  }
  /** Real AudioParams only drop events scheduled at or after `time`; events before it stand. */
  cancelScheduledValues(time: number): this {
    this.scheduled = this.scheduled.filter((e) => e.time < time);
    this.ramps = this.ramps.filter((e) => e.time < time);
    return this;
  }

  /**
   * Play the event list forward and return the value at `t`: hold the value of the last
   * `setValueAtTime` at or before `t`, linearly interpolate across a `linearRampToValueAtTime`
   * that spans `t`, and hold the initial value before any event. This is what makes a gain
   * envelope (a fade) actually assertable in a test, instead of only asserting the raw
   * schedule calls happened.
   */
  valueAt(t: number): number {
    type Point = { time: number; value: number; kind: "set" | "ramp" };
    const points: Point[] = [
      ...this.scheduled.map((e) => ({ ...e, kind: "set" as const })),
      ...this.ramps.map((e) => ({ ...e, kind: "ramp" as const })),
    ].sort((a, b) => a.time - b.time);

    let last: Point = { time: -Infinity, value: this.initialValue, kind: "set" };
    for (const p of points) {
      if (t < p.time) {
        if (p.kind === "ramp" && last.time > -Infinity) {
          const span = p.time - last.time;
          if (span <= 0) return p.value;
          const frac = (t - last.time) / span;
          return last.value + (p.value - last.value) * frac;
        }
        return last.value;
      }
      last = p;
    }
    return last.value;
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
  /** Every media element source created. */
  mediaSources: MockMediaElementSourceNode[] = [];

  createMediaElementSource(_element: unknown): MockMediaElementSourceNode {
    const node = new MockMediaElementSourceNode();
    this.mediaSources.push(node);
    return node;
  }

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

/**
 * Install a fetch stub. Returns a restore fn.
 * `contentLength` is reported on the `content-length` header when given.
 */
export function stubFetch(ok = true, status = 200, contentLength?: number): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-length" && contentLength !== undefined
            ? String(contentLength)
            : null,
      },
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as unknown as Response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Enough of an HTMLAudioElement for the element strategy to be tested in Node. */
export class MockMediaElement {
  src = "";
  crossOrigin: string | null = null;
  preload = "auto";
  currentTime = 0;
  duration = NaN;
  paused = true;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  async play(): Promise<void> {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  /** Test helper: announce metadata with a duration. */
  fireLoadedMetadata(duration: number): void {
    this.duration = duration;
    for (const fn of [...(this.listeners.get("loadedmetadata") ?? [])]) fn();
  }
  /** Test helper: announce the natural end. */
  fireEnded(): void {
    for (const fn of [...(this.listeners.get("ended") ?? [])]) fn();
  }
  /** Test helper: announce a load failure. */
  fireError(): void {
    for (const fn of [...(this.listeners.get("error") ?? [])]) fn();
  }
}

export class MockMediaElementSourceNode {
  connections: unknown[] = [];
  connect(destination?: unknown): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.connections = [];
  }
}
