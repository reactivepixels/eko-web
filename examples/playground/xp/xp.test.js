import { describe, expect, it } from "vitest";
import {
  BALLOON_MS,
  clampWindow,
  createBalloons,
  dismissBalloon,
  formatClock,
  formatTime,
  parseTitle,
  showBalloon,
  spectrumBars,
  tickBalloons,
  createTransport,
  isPlaying,
  transportEvent,
  transportLabel,
} from "./lib/shell.js";

describe("clampWindow", () => {
  const desk = { w: 800, h: 570 };

  it("leaves a window that fits where it is", () => {
    expect(clampWindow({ x: 200, y: 100, w: 346, h: 300 }, desk)).toEqual({
      x: 200,
      y: 100,
      w: 346,
      h: 300,
    });
  });

  it("keeps it on the desktop on every side", () => {
    expect(clampWindow({ x: -50, y: -9, w: 346, h: 300 }, desk)).toMatchObject({ x: 0, y: 0 });
    expect(clampWindow({ x: 900, y: 900, w: 346, h: 300 }, desk)).toMatchObject({
      x: 454,
      y: 270,
    });
  });

  it("pins the title bar on screen when the desktop is smaller than the window", () => {
    expect(clampWindow({ x: 50, y: 50, w: 400, h: 300 }, { w: 300, h: 200 })).toMatchObject({
      x: 0,
      y: 0,
    });
  });
});

describe("formatTime and formatClock", () => {
  it("reads like the player", () => {
    expect(formatTime(107)).toBe("1:47");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(-3)).toBe("0:00");
  });

  it("tells the time like the taskbar", () => {
    expect(formatClock(new Date(2026, 0, 1, 16, 20))).toBe("4:20 PM");
    expect(formatClock(new Date(2026, 0, 1, 0, 5))).toBe("12:05 AM");
    expect(formatClock(new Date(2026, 0, 1, 12, 0))).toBe("12:00 PM");
  });
});

describe("parseTitle", () => {
  it("splits artist and title", () => {
    expect(parseTitle("Massive Attack - Teardrop")).toEqual({
      title: "Teardrop",
      artist: "Massive Attack",
      album: "",
    });
  });

  it("drops a leading track number", () => {
    expect(parseTitle("07 Ondine Vale - Low Tide").title).toBe("Low Tide");
    expect(parseTitle("07. Low Tide")).toEqual({ title: "Low Tide", artist: "", album: "" });
  });

  it("reads a numbered part as an album", () => {
    expect(parseTitle("EKO - Ember Set II. Relay")).toEqual({
      title: "Relay",
      artist: "EKO",
      album: "Ember Set",
    });
  });

  it("never comes back empty", () => {
    expect(parseTitle("  ").title).toBe("  ");
    expect(parseTitle("1999").title).toBe("1999");
  });
});

describe("balloons", () => {
  it("shows the newest and expires it", () => {
    const b = createBalloons();
    showBalloon(b, { text: "one" }, "a", 0);
    showBalloon(b, { text: "two" }, "b", 100);
    expect(b.current.text).toBe("two");
    expect(tickBalloons(b, 100 + BALLOON_MS - 1)).toBe(false);
    expect(tickBalloons(b, 100 + BALLOON_MS)).toBe(true);
    expect(b.current).toBeNull();
  });

  it("does not repeat the same track straight away, but does later", () => {
    const b = createBalloons();
    showBalloon(b, { text: "one" }, "a", 0);
    dismissBalloon(b);
    showBalloon(b, { text: "one again" }, "a", 500);
    expect(b.current).toBeNull();
    showBalloon(b, { text: "one later" }, "a", 5000);
    expect(b.current.text).toBe("one later");
  });
});

describe("spectrumBars", () => {
  it("maps bins to log-spaced bars in 0..1", () => {
    const bytes = new Uint8Array(1024);
    bytes[1] = 255;
    const bars = spectrumBars(bytes, 48000, 2048, 38);
    expect(bars).toHaveLength(38);
    expect(bars[0]).toBe(1);
    expect(Math.max(...bars.slice(10))).toBe(0);
  });
});

describe("transport", () => {
  it("follows the engine's play and pause, whoever caused them", () => {
    const t = createTransport();
    expect(transportLabel(t, false)).toBe("Ready");
    transportEvent(t, "play");
    expect(isPlaying(t)).toBe(true);
    // A hardware pause key drives the engine directly; the window hears only its event.
    transportEvent(t, "pause");
    expect(transportLabel(t, true)).toBe("Paused");
    transportEvent(t, "play");
    expect(transportLabel(t, true)).toBe("Playing");
  });

  it("keeps Stop as stopped when the engine reports the pause it caused", () => {
    const t = transportEvent(createTransport(), "play");
    transportEvent(t, "stop");
    transportEvent(t, "pause");
    expect(t).toEqual({ stopped: true, paused: false, ended: false });
    expect(transportLabel(t, true)).toBe("Stopped");
  });

  it("remembers running off the end until the tape is moved or played", () => {
    const t = transportEvent(transportEvent(createTransport(), "play"), "ended");
    expect(t.ended).toBe(true);
    expect(isPlaying(t)).toBe(false);
    transportEvent(t, "moved");
    expect(t.ended).toBe(false);
    transportEvent(transportEvent(t, "ended"), "play");
    expect(t.ended).toBe(false);
  });
});
