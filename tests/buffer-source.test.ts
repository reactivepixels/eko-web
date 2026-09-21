import { describe, it, expect, afterEach } from "vitest";
import { BufferSourceStrategy } from "../src/engine/sources/buffer-source";
import { EkoError } from "../src/engine/errors";
import { MockAudioContext, MockGainNode, makeToneBuffer, stubFetch } from "./mock-audio";

const OPTS = { normalize: false, targetLufs: -16 };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function ctxWith(buffer = makeToneBuffer(0.5)) {
  const ctx = new MockAudioContext();
  ctx.nextBuffer = buffer;
  return ctx;
}

describe("BufferSourceStrategy", () => {
  it("declares itself gapless-capable", () => {
    const strategy = new BufferSourceStrategy();
    expect(strategy.kind).toBe("buffer");
    expect(strategy.canGapless).toBe(true);
  });

  it("fetches, decodes, and reports the buffer duration", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac" },
      ctx as unknown as AudioContext,
      OPTS,
    );
    expect(loaded.kind).toBe("buffer");
    expect(loaded.canGapless).toBe(true);
    expect(loaded.duration).toBeCloseTo(0.5, 3);
    expect(loaded.normGain).toBe(1);
  });

  it("throws a coded fetch_failed on a bad response", async () => {
    restore = stubFetch(false, 404);
    const ctx = ctxWith();
    await expect(
      new BufferSourceStrategy().load({ src: "/x.flac" }, ctx as unknown as AudioContext, OPTS),
    ).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("throws a coded decode_failed when decodeAudioData rejects", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const boom = new Error("bad bytes");
    ctx.decodeAudioData = async () => {
      throw boom;
    };
    const error = (await new BufferSourceStrategy()
      .load({ src: "/x.flac" }, ctx as unknown as AudioContext, OPTS)
      .catch((e: unknown) => e as EkoError)) as EkoError;
    expect(error.code).toBe("decode_failed");
    expect(error.cause).toBe(boom);
  });

  it("builds a fresh node on every start, so a track can be restarted", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac" },
      ctx as unknown as AudioContext,
      OPTS,
    );
    const destination = new MockGainNode();
    loaded.connect(destination as unknown as AudioNode);

    loaded.start(0, 0);
    expect(ctx.sources.length).toBe(1);
    loaded.stop();
    loaded.start(0, 0.25);
    expect(ctx.sources.length).toBe(2);
    expect(ctx.sources[1]!.startOffset).toBeCloseTo(0.25, 6);
  });

  it("connects every fresh node to the destination given to connect()", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac" },
      ctx as unknown as AudioContext,
      OPTS,
    );
    const destination = new MockGainNode();
    loaded.connect(destination as unknown as AudioNode);

    loaded.start(0, 0);
    expect(ctx.sources[0]!.connections).toEqual([destination]);

    loaded.stop();
    loaded.start(0, 0);
    expect(ctx.sources[1]!.connections).toEqual([destination]);
  });

  it("reports a natural end but stays quiet when we stopped it ourselves", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac" },
      ctx as unknown as AudioContext,
      OPTS,
    );
    let ended = 0;
    loaded.onEnded(() => {
      ended += 1;
    });

    loaded.start(0, 0);
    ctx.sources[0]!.fireEnded();
    expect(ended).toBe(1);

    loaded.start(0, 0);
    loaded.stop();
    ctx.sources[1]!.fireEnded();
    expect(ended).toBe(1); // a stop is not an end
  });

  it("throws a coded destroyed error on start() after dispose(), instead of playing silently", async () => {
    restore = stubFetch();
    const ctx = ctxWith();
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac" },
      ctx as unknown as AudioContext,
      OPTS,
    );
    const destination = new MockGainNode();
    loaded.connect(destination as unknown as AudioNode);
    loaded.start(0, 0);
    const sourcesBefore = ctx.sources.length;

    loaded.dispose();

    expect(() => loaded.start(0, 0)).toThrow(expect.objectContaining({ code: "destroyed" }));
    // No fresh, disconnected node was built either.
    expect(ctx.sources.length).toBe(sourcesBefore);
  });

  it("uses a track's precomputed gainDb when normalizing", async () => {
    restore = stubFetch();
    const ctx = ctxWith(makeToneBuffer(0.1));
    const loaded = await new BufferSourceStrategy().load(
      { src: "/a.flac", gainDb: -6 },
      ctx as unknown as AudioContext,
      { normalize: true, targetLufs: -16 },
    );
    // -6 dB is roughly 0.501 linear, and the 0.1 peak leaves plenty of clamp headroom.
    expect(loaded.normGain).toBeCloseTo(0.5012, 3);
  });
});
