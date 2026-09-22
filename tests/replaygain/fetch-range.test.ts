import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fetchReplayGain } from "../../src/replaygain/fetch-range";
import { buildApev2 } from "../fixtures/replaygain/build";

/**
 * Tests `fetchReplayGain`, the Range-aware fetcher: the only module in this subpath
 * that does IO. Every test stubs `globalThis.fetch` itself rather than hitting a real
 * network, and every test that cares about WHICH bytes were requested asserts the
 * actual `Range` header value sent, not just how many times `fetch` was called: a
 * fetcher that requests the wrong bytes but the right number of times must fail here.
 */

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/replaygain/${name}`, import.meta.url)));

const HEAD_RANGE = "bytes=0-65535";
const TAIL_RANGE = "bytes=-65536";

interface StubResponse {
  status: number;
  body?: Uint8Array;
}

interface RecordedCall {
  url: string;
  range: string | null;
}

/**
 * Stubs `globalThis.fetch` with a queue of canned responses, one consumed per call
 * (or the string `"network-error"`, which makes that call's `fetch` reject, the same
 * observable shape a CORS rejection produces). Every call's URL and its actual `Range`
 * header (read via the real `Headers` class, so this doesn't care whether the
 * implementation passes a plain object or a `Headers` instance) are recorded in
 * `calls`, in order.
 */
function stubFetchSequence(responses: (StubResponse | "network-error")[]): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    calls.push({ url: String(url), range });

    const response = responses[index];
    index++;
    if (response === undefined) {
      throw new Error("stubFetchSequence: ran out of canned responses");
    }
    if (response === "network-error") {
      throw new Error("simulated network failure");
    }

    const body = response.body ?? new Uint8Array(0);
    return {
      status: response.status,
      arrayBuffer: async () => body.slice().buffer,
    } as unknown as Response;
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("fetchReplayGain: Range-aware fetching", () => {
  it("requests only the head range when the server honours Range and the head carries a tag", async () => {
    const apeTag = buildApev2({ replaygain_track_gain: "-6.50 dB" }, { footerOnly: true });
    const stub = stubFetchSequence([{ status: 206, body: apeTag }]);
    restore = stub.restore;

    const tags = await fetchReplayGain("https://example.test/track.ape");

    expect(tags).toEqual({ gainDb: -6.5 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.range).toBe(HEAD_RANGE);
  });

  it("parses the whole body when the server ignores Range and returns 200 instead of 206", async () => {
    const bytes = load("tone.flac");
    const stub = stubFetchSequence([{ status: 200, body: bytes }]);
    restore = stub.restore;

    const tags = await fetchReplayGain("https://example.test/tone.flac");

    expect(tags).toEqual({ gainDb: -6.5, peak: 0.988525 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.range).toBe(HEAD_RANGE);
  });

  it("does not request a tail range after a 200 response, even when it carries no tags: it is already the whole file", async () => {
    const untagged = new Uint8Array(50); // no recognized magic, no tags
    const stub = stubFetchSequence([{ status: 200, body: untagged }]);
    restore = stub.restore;

    await expect(fetchReplayGain("https://example.test/untagged-whole.raw")).resolves.toEqual({});
    expect(stub.calls).toHaveLength(1);
  });

  it("requests the tail range when the head range yields no tags", async () => {
    const headOnlyBytes = new Uint8Array(100); // no magic, no tags
    const apeTag = buildApev2({ replaygain_track_peak: "0.988525" }, { footerOnly: true });
    const stub = stubFetchSequence([
      { status: 206, body: headOnlyBytes },
      { status: 206, body: apeTag },
    ]);
    restore = stub.restore;

    const tags = await fetchReplayGain("https://example.test/track.mp3");

    expect(tags).toEqual({ peak: 0.988525 });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]?.range).toBe(HEAD_RANGE);
    expect(stub.calls[1]?.range).toBe(TAIL_RANGE);
  });

  it("reads a non-faststart MP4's tags from the tail range, via real encoder-produced bytes", async () => {
    // tone-keys.m4a: mdat spans [36, 1329), moov spans [1329, 2301) (see mp4.test.ts's
    // dumped atom tree: this is a REAL ffmpeg-produced file, moov after mdat). A head
    // range covering only the file's front never reaches moov; the tail range must,
    // sliced mid-mdat exactly as a real Range fetch against a large file whose moov
    // trails at the very end would return: no ftyp, no atom boundary at its own
    // offset 0, moov starting mid-fragment.
    const wholeFile = load("tone-keys.m4a");
    const headOnly = wholeFile.slice(0, 700); // ftyp/free/mdat's start: no moov here
    const tailFragment = wholeFile.slice(700); // mid-mdat onward, including all of moov

    const stub = stubFetchSequence([
      { status: 206, body: headOnly },
      { status: 206, body: tailFragment },
    ]);
    restore = stub.restore;

    const tags = await fetchReplayGain("https://example.test/tone-keys.m4a");

    expect(tags).toEqual({ gainDb: -6.5, peak: 0.988525 });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]?.range).toBe(HEAD_RANGE);
    expect(stub.calls[1]?.range).toBe(TAIL_RANGE);
  });

  it("resolves to {} rather than rejecting on a 416 Range Not Satisfiable", async () => {
    const stub = stubFetchSequence([{ status: 416 }]);
    restore = stub.restore;

    await expect(fetchReplayGain("https://example.test/empty.mp3")).resolves.toEqual({});
    expect(stub.calls).toHaveLength(1);
  });

  it("resolves to {} rather than rejecting on a network failure (also covers a CORS rejection: same rejected-promise shape)", async () => {
    const stub = stubFetchSequence(["network-error"]);
    restore = stub.restore;

    await expect(fetchReplayGain("https://example.test/unreachable.mp3")).resolves.toEqual({});
    expect(stub.calls).toHaveLength(1);
  });

  it("resolves to {} when both the head and the tail requests come back empty", async () => {
    const stub = stubFetchSequence([{ status: 206, body: new Uint8Array(50) }, { status: 416 }]);
    restore = stub.restore;

    await expect(fetchReplayGain("https://example.test/untagged.mp3")).resolves.toEqual({});
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]?.range).toBe(HEAD_RANGE);
    expect(stub.calls[1]?.range).toBe(TAIL_RANGE);
  });

  it("resolves to {} when the tail request itself fails over the network, after an empty head", async () => {
    const stub = stubFetchSequence([{ status: 206, body: new Uint8Array(50) }, "network-error"]);
    restore = stub.restore;

    await expect(fetchReplayGain("https://example.test/flaky-tail.mp3")).resolves.toEqual({});
    expect(stub.calls).toHaveLength(2);
  });
});
