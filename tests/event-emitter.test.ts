import { describe, it, expect, vi } from "vitest";
import { Emitter } from "../src/engine/event-emitter";

describe("Emitter", () => {
  it("delivers payloads to subscribers", () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.on("timeupdate", fn);
    e.emit("timeupdate", { currentTime: 5, duration: 100 });
    expect(fn).toHaveBeenCalledWith({ currentTime: 5, duration: 100 });
  });

  it("supports void events with no payload arg", () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.on("play", fn);
    e.emit("play");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("the returned unsubscribe stops delivery", () => {
    const e = new Emitter();
    const fn = vi.fn();
    const off = e.on("pause", fn);
    off();
    e.emit("pause");
    expect(fn).not.toHaveBeenCalled();
  });

  it("off() removes a specific listener", () => {
    const e = new Emitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on("ended", a);
    e.on("ended", b);
    e.off("ended", a);
    e.emit("ended");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a listener unsubscribing mid-emit doesn't skip the others", () => {
    const e = new Emitter();
    const calls: string[] = [];
    const off1 = e.on("play", () => {
      calls.push("one");
      off1(); // remove self during emit
    });
    e.on("play", () => calls.push("two"));
    e.emit("play");
    expect(calls).toEqual(["one", "two"]);
  });

  it("clear() removes everything", () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.on("play", fn);
    e.clear();
    e.emit("play");
    expect(fn).not.toHaveBeenCalled();
  });
});
