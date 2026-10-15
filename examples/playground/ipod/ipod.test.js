import { describe, expect, it } from "vitest";
import { coverSvg, hashString } from "./art.js";
import { buildLibrary, parseTrack, romanToNumber } from "./library.js";
import { createNav, cycleSetting, nowPlayingScreen, VISIBLE_ROWS } from "./menu.js";
import { angleDelta, angleOf, createTracker, onRing, STEP_DEG, zoneOf } from "./wheel.js";

describe("wheel", () => {
  it("tells the ring from the centre button", () => {
    expect(onRing(93, 93, 93, 93)).toBe(false);
    expect(onRing(93 + 30, 93, 93, 93)).toBe(false);
    expect(onRing(93 + 66, 93, 93, 93)).toBe(true);
  });

  it("does not bridge a jump when the tracker is lifted and set down elsewhere", () => {
    const t = createTracker();
    t.start(0);
    expect(t.move(14)).toBe(0);
    t.end();
    // Re-entering on the far side: the first point only re-seeds.
    expect(t.move(200)).toBe(0);
    expect(t.move(215)).toBe(1);
  });

  it("measures angles from the top, clockwise", () => {
    expect(angleOf(0, -10, 0, 0)).toBeCloseTo(0);
    expect(angleOf(10, 0, 0, 0)).toBeCloseTo(90);
    expect(angleOf(0, 10, 0, 0)).toBeCloseTo(180);
    expect(angleOf(-10, 0, 0, 0)).toBeCloseTo(270);
  });

  it("takes the short way round across the top", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
  });

  it("turns degrees into whole steps and keeps the remainder", () => {
    const t = createTracker();
    t.start(0);
    expect(t.move(STEP_DEG * 0.6)).toBe(0);
    expect(t.move(STEP_DEG * 1.2)).toBe(1);
    expect(t.move(STEP_DEG * 3.2)).toBe(2);
    expect(t.move(STEP_DEG * 0.1)).toBe(-2);
    expect(t.travelled).toBeCloseTo(STEP_DEG * 6.3);
  });

  it("counts a full spin through the top as continuous", () => {
    const t = createTracker(30);
    t.start(300);
    let steps = 0;
    for (let a = 310; a <= 300 + 360; a += 10) steps += t.move(a % 360);
    expect(steps).toBe(12);
  });

  it("knows the centre button and the four quarters", () => {
    const z = (x, y) => zoneOf(x, y, 100, 100, 40, 95);
    expect(z(100, 100)).toBe("center");
    expect(z(100, 20)).toBe("menu");
    expect(z(180, 100)).toBe("next");
    expect(z(100, 180)).toBe("play");
    expect(z(20, 100)).toBe("prev");
    expect(z(0, 0)).toBeNull();
  });
});

describe("library", () => {
  it("reads artist, album, title and track numbers out of file names", () => {
    expect(parseTrack("The Paper Hours - Sodium Lights")).toMatchObject({
      artist: "The Paper Hours",
      title: "Sodium Lights",
      album: "Unknown Album",
    });
    expect(parseTrack("03 Coastal Static - Low Tide", "Coastal Static")).toMatchObject({
      number: 3,
      artist: "Coastal Static",
      album: "Coastal Static",
      title: "Low Tide",
    });
    expect(parseTrack("A - B - C - D")).toMatchObject({ artist: "A", album: "B", title: "C - D" });
    expect(parseTrack("Just A Title")).toMatchObject({
      artist: "Unknown Artist",
      title: "Just A Title",
    });
  });

  it("treats a numbered movement as part of a work", () => {
    expect(parseTrack("EKO - Ember Set II. Relay")).toMatchObject({
      artist: "EKO",
      album: "Ember Set",
      title: "Relay",
      number: 2,
    });
    expect(romanToNumber("IV")).toBe(4);
    expect(romanToNumber("IX")).toBe(9);
  });

  it("groups songs into albums in track order and sorts like an iPod", () => {
    const lib = buildLibrary([
      { title: "EKO - Ember Set II. Relay" },
      { title: "EKO - Ember Set I. Glass Dawn" },
      { title: "The Zebras - Alpha" },
      { title: "Beta Band - Gamma" },
    ]);
    expect(lib.albums.find((a) => a.name === "Ember Set").songs.map((s) => s.number)).toEqual([
      1, 2,
    ]);
    expect(lib.artists.map((a) => a.name)).toEqual(["Beta Band", "EKO", "The Zebras"]);
    expect(lib.songs[0].name).toBe("Alpha");
    expect(lib.songs.map((s) => s.name)).toContain("Glass Dawn");
    expect(lib.songs.every((s) => typeof s.index === "number")).toBe(true);
  });
});

describe("menus", () => {
  const ctxWith = (titles, extra = {}) => {
    const library = buildLibrary(titles.map((title) => ({ title })));
    let settings = { shuffle: 0, repeat: 0, clicker: 0 };
    const ctx = () => ({ library, settings, nowPlaying: false, ...extra });
    return {
      ctx,
      setSettings: (s) => (settings = s),
    };
  };

  it("opens Music > Songs and hands back a play action", () => {
    const { ctx } = ctxWith(["A - One", "A - Two"]);
    const nav = createNav(ctx);
    expect(nav.rows().map((r) => r.label)).toEqual(["Music", "Shuffle Songs", "Settings"]);
    expect(nav.select()).toEqual({ type: "pushed" });
    expect(nav.screen.title).toBe("Music");
    nav.scroll(2);
    nav.select();
    expect(nav.screen.title).toBe("Songs");
    nav.scroll(1);
    const action = nav.select();
    expect(action.type).toBe("play");
    expect(action.index).toBe(1);
    expect(action.songs.map((s) => s.name)).toEqual(["One", "Two"]);
  });

  it("clamps the selection and scrolls the window with it", () => {
    const titles = Array.from({ length: 20 }, (_, i) => `A - Song ${String(i).padStart(2, "0")}`);
    const { ctx } = ctxWith(titles);
    const nav = createNav(ctx);
    nav.select();
    nav.scroll(2);
    nav.select();
    expect(nav.scroll(-5)).toBe(false);
    nav.scroll(12);
    expect(nav.screen.sel).toBe(12);
    expect(nav.screen.top).toBe(12 - VISIBLE_ROWS + 1);
    nav.scroll(100);
    expect(nav.screen.sel).toBe(19);
    expect(nav.screen.top).toBe(20 - VISIBLE_ROWS);
  });

  it("goes back one screen at a time and stops at the top", () => {
    const { ctx } = ctxWith(["A - One"]);
    const nav = createNav(ctx);
    nav.select();
    expect(nav.back()).toBe(true);
    expect(nav.screen.id).toBe("main");
    expect(nav.back()).toBe(false);
  });

  it("shows settings with their values, and cycles them", () => {
    const { ctx, setSettings } = ctxWith([]);
    const nav = createNav(ctx);
    nav.scroll(2);
    nav.select();
    const repeat = nav.rows()[1];
    expect(repeat).toMatchObject({ label: "Repeat", detail: "Off" });
    setSettings(cycleSetting(ctx().settings, "repeat"));
    expect(nav.rows()[1].detail).toBe("One");
    setSettings(cycleSetting(cycleSetting(ctx().settings, "repeat"), "repeat"));
    expect(nav.rows()[1].detail).toBe("Off");
  });

  it("offers Now Playing only while something plays, and never stacks it twice", () => {
    const { ctx } = ctxWith(["A - One"], { nowPlaying: true });
    const nav = createNav(ctx);
    expect(nav.rows().at(-1)).toMatchObject({ label: "Now Playing", action: { type: "now" } });
    nav.push(nowPlayingScreen());
    nav.push(nowPlayingScreen());
    expect(nav.depth).toBe(2);
    expect(nav.select()).toBeNull();
    expect(nav.scroll(1)).toBe(false);
  });

  it("says so when there is nothing to play", () => {
    const { ctx } = ctxWith([]);
    const nav = createNav(ctx);
    nav.select();
    expect(nav.rows().at(-1).label).toBe("Sync some music first");
    nav.scroll(2);
    nav.select();
    expect(nav.rows()).toEqual([{ label: "No songs" }]);
    expect(nav.select()).toBeNull();
  });
});

describe("cover art", () => {
  it("is the same sleeve for the same album, and escapes the name", () => {
    expect(coverSvg("Ember Set", "EKO")).toBe(coverSvg("Ember Set", "EKO"));
    expect(coverSvg("A <b> & C")).toContain("A &lt;B&gt; &amp; C");
    expect(hashString("a")).not.toBe(hashString("b"));
  });
});
