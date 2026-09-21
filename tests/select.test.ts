import { describe, it, expect, afterEach } from "vitest";
import { selectStrategy, probeContentLength } from "../src/engine/sources/select";
import { stubFetch } from "./mock-audio";

const MB = 1024 * 1024;
const OPTS = { source: "auto" as const, bufferMaxBytes: 50 * MB };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("probeContentLength", () => {
  it("reads the content-length header", async () => {
    restore = stubFetch(true, 200, 1234);
    expect(await probeContentLength("/a.flac")).toBe(1234);
  });

  it("returns null when the header is absent", async () => {
    restore = stubFetch();
    expect(await probeContentLength("/a.flac")).toBeNull();
  });

  it("returns null when the request fails rather than throwing", async () => {
    restore = stubFetch(false, 500);
    expect(await probeContentLength("/a.flac")).toBeNull();
  });
});

describe("selectStrategy", () => {
  it("takes the buffer path for a normal-sized file", async () => {
    restore = stubFetch(true, 200, 8 * MB);
    expect((await selectStrategy({ src: "/a.flac" }, OPTS)).kind).toBe("buffer");
  });

  it("takes the element path above the threshold", async () => {
    restore = stubFetch(true, 200, 400 * MB);
    expect((await selectStrategy({ src: "/set.flac" }, OPTS)).kind).toBe("element");
  });

  it("takes the buffer path when the length is unknown", async () => {
    restore = stubFetch();
    expect((await selectStrategy({ src: "/a.flac" }, OPTS)).kind).toBe("buffer");
  });

  it("honours an explicit engine-wide preference without probing", async () => {
    restore = stubFetch(true, 200, 400 * MB);
    const strategy = await selectStrategy(
      { src: "/set.flac" },
      { source: "buffer", bufferMaxBytes: 50 * MB },
    );
    expect(strategy.kind).toBe("buffer");
  });

  it("lets a track override the engine preference", async () => {
    restore = stubFetch(true, 200, 1 * MB);
    const strategy = await selectStrategy({ src: "/a.flac", source: "element" }, OPTS);
    expect(strategy.kind).toBe("element");
  });

  it("respects a custom threshold", async () => {
    restore = stubFetch(true, 200, 2 * MB);
    const strategy = await selectStrategy(
      { src: "/a.flac" },
      { source: "auto", bufferMaxBytes: MB },
    );
    expect(strategy.kind).toBe("element");
  });
});
