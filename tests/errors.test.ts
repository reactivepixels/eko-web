import { describe, it, expect } from "vitest";
import { EkoError } from "../src/engine/errors";

describe("EkoError", () => {
  it("is a real Error carrying a machine-readable code", () => {
    const err = new EkoError("fetch_failed", "could not fetch /a.flac");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EkoError");
    expect(err.code).toBe("fetch_failed");
    expect(err.message).toBe("could not fetch /a.flac");
  });

  it("defaults prefetch_failed to recoverable and everything else to fatal", () => {
    expect(new EkoError("prefetch_failed", "x").recoverable).toBe(true);
    expect(new EkoError("decode_failed", "x").recoverable).toBe(false);
    expect(new EkoError("autoplay_blocked", "x").recoverable).toBe(false);
  });

  it("lets the caller override recoverable", () => {
    expect(new EkoError("decode_failed", "x", { recoverable: true }).recoverable).toBe(true);
  });

  it("keeps the underlying cause for debugging", () => {
    const cause = new TypeError("inner");
    expect(new EkoError("decode_failed", "x", { cause }).cause).toBe(cause);
  });
});
