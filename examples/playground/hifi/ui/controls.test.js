import { describe, expect, it } from "vitest";
import { dragValue, quantize } from "./controls.js";

describe("quantize", () => {
  it("snaps to the step grid from min and clamps", () => {
    expect(quantize(0.26, -1, 1, 0.1)).toBe(0.3);
    expect(quantize(5.4, 0, 8, 0.05)).toBe(5.4);
    expect(quantize(99, 0, 8, 1)).toBe(8);
    expect(quantize(-12.3, -12, 12, 0.5)).toBe(-12);
  });
});

describe("dragValue", () => {
  it("turns up for a drag up or right, a full sweep per travel", () => {
    const r = { min: 0, max: 10, travel: 100 };
    expect(dragValue(5, 0, -50, r)).toBe(10);
    expect(dragValue(5, 20, 0, r)).toBe(7);
    expect(dragValue(5, 0, 400, r)).toBe(0);
  });
});
