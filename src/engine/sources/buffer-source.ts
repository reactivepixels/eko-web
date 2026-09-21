import { EkoError } from "../errors";
import { measureLoudnessLufs, samplePeak, computeNormalizationGain, dbToLinear } from "../loudness";
import type { EkoTrack } from "../../types";
import type { AudioSourceStrategy, LoadedSource, LoadOptions } from "./source";

/**
 * Decode the whole file to an AudioBuffer and play it through an AudioBufferSourceNode.
 *
 * This is the only path that can be scheduled to a sample, so it is the only path that
 * gives true gapless. The cost is memory: decoded audio is Float32 at the context rate,
 * so a five minute track is roughly 115 MB and gapless holds two at a boundary. See
 * `select.ts` for how long files avoid this path.
 */
export class BufferSourceStrategy implements AudioSourceStrategy {
  readonly kind = "buffer" as const;
  readonly canGapless = true;

  async load(track: EkoTrack, ctx: AudioContext, options: LoadOptions): Promise<LoadedSource> {
    const bytes = await fetchBytes(track.src);

    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (cause) {
      throw new EkoError("decode_failed", `eko-web: could not decode ${track.src}`, { cause });
    }

    return new BufferLoadedSource(track, ctx, buffer, computeNormGain(track, buffer, options));
  }
}

async function fetchBytes(src: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(src);
    if (!res.ok) {
      throw new EkoError("fetch_failed", `eko-web: fetch failed for ${src} (${res.status})`);
    }
    return await res.arrayBuffer();
  } catch (cause) {
    if (cause instanceof EkoError) throw cause;
    throw new EkoError("fetch_failed", `eko-web: fetch failed for ${src}`, { cause });
  }
}

/**
 * Prefer a precomputed tag gain; otherwise measure the decoded buffer. Both are clamped
 * against sample peak so normalization can never introduce clipping.
 */
function computeNormGain(track: EkoTrack, buffer: AudioBuffer, options: LoadOptions): number {
  if (!options.normalize) return 1;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const peak = samplePeak(channels);

  if (typeof track.gainDb === "number") {
    const gain = dbToLinear(track.gainDb);
    return peak > 0 ? Math.min(gain, 1 / peak) : gain;
  }
  return computeNormalizationGain(
    measureLoudnessLufs(channels, buffer.sampleRate),
    options.targetLufs,
    peak,
  );
}

class BufferLoadedSource implements LoadedSource {
  readonly kind = "buffer" as const;
  readonly canGapless = true;

  private node: AudioBufferSourceNode | null = null;
  private destination: AudioNode | null = null;
  private endedFn: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly track: EkoTrack,
    private readonly ctx: AudioContext,
    private readonly buffer: AudioBuffer,
    readonly normGain: number,
  ) {}

  get duration(): number {
    return this.buffer.duration;
  }

  connect(destination: AudioNode): void {
    this.destination = destination;
  }

  start(when: number, offset: number): void {
    if (this.disposed) {
      // Without this, a stale start() after dispose() would build a fresh node, silently
      // skip connect() (dispose() already nulled `destination`), and play into nothing
      // forever with no error to explain the silence.
      throw new EkoError("destroyed", "eko-web: cannot start a source that has been disposed.");
    }
    // AudioBufferSourceNode is single-use, so every start gets a fresh node.
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    if (this.destination) node.connect(this.destination);
    node.onended = (): void => this.endedFn?.();
    node.start(when, offset);
    this.node = node;
  }

  stop(when?: number): void {
    const node = this.node;
    if (!node) return;
    this.node = null;
    try {
      if (when === undefined) node.stop();
      else node.stop(when);
    } catch {
      /* never started */
    }
    // Replace the ended handler before disconnecting, so an explicit stop is not reported
    // as a natural end, and so a scheduled stop (a fade-out) is not cut short by
    // disconnecting while it is still ramping.
    node.onended = (): void => node.disconnect();
  }

  onEnded(fn: () => void): void {
    this.endedFn = fn;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.endedFn = null;
    this.destination = null;
  }
}
