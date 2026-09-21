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

  it("takes the buffer path for a blob: URL without probing (browsers refuse HEAD on it)", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // A real browser throws on HEAD against a blob: URL; behave as if it succeeded
      // instead, so the only way this test can fail is on the call count itself, not on
      // whatever the catch-all in probeContentLength happens to do with an error.
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => String(400 * MB) },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };
    const strategy = await selectStrategy({ src: "blob:http://localhost/some-uuid" }, OPTS);
    expect(calls).toBe(0);
    expect(strategy.kind).toBe("buffer");
  });

  it("takes the buffer path for a data: URL without probing", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => String(400 * MB) },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };
    const strategy = await selectStrategy({ src: "data:audio/wav;base64,AAAA" }, OPTS);
    expect(calls).toBe(0);
    expect(strategy.kind).toBe("buffer");
  });
});

describe("probeContentLength: blob/data URLs", () => {
  it("returns null for a blob: URL without calling fetch", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => "1234" },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };
    expect(await probeContentLength("blob:http://localhost/some-uuid")).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns null for a data: URL without calling fetch", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => "1234" },
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = originalFetch;
    };
    expect(await probeContentLength("data:audio/wav;base64,AAAA")).toBeNull();
    expect(calls).toBe(0);
  });
});
