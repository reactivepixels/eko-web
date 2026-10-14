import { describe, expect, it } from "vitest";
import {
  clampRect,
  defaultLayout,
  dockedGroup,
  moveGroup,
  restoreLayout,
  snapRect,
  touching,
} from "./geometry.js";

const B = { w: 1000, h: 800 };

describe("defaultLayout", () => {
  it("stacks main, eq and playlist docked and centred", () => {
    const l = defaultLayout(B);
    expect(l.main).toMatchObject({ w: 275, h: 116, visible: true });
    expect(l.eq.y).toBe(l.main.y + 116);
    expect(l.pl.y).toBe(l.eq.y + 116);
    expect(l.main.x).toBe(Math.round((1000 - 275) / 2));
  });
});

describe("snapRect", () => {
  it("snaps a near edge flush against another window", () => {
    const other = { x: 100, y: 100, w: 275, h: 116 };
    const moving = { x: 104, y: 223, w: 275, h: 116 };
    expect(snapRect(moving, [other], B)).toMatchObject({ x: 100, y: 216 });
  });
  it("snaps to the desktop edges", () => {
    expect(snapRect({ x: 6, y: 795 - 116, w: 275, h: 116 }, [], B)).toMatchObject({
      x: 0,
      y: 800 - 116,
    });
  });
  it("leaves far rects alone", () => {
    const r = { x: 300, y: 300, w: 275, h: 116 };
    expect(snapRect(r, [{ x: 0, y: 0, w: 275, h: 116 }], B)).toEqual(r);
  });
  it("does not snap x to a window that is far away vertically", () => {
    const other = { x: 100, y: 0, w: 275, h: 116 };
    const moving = { x: 104, y: 500, w: 275, h: 116 };
    expect(snapRect(moving, [other], B).x).toBe(104);
  });
});

describe("clampRect", () => {
  it("keeps a dragged window on the desktop", () => {
    expect(clampRect({ x: 900, y: -20, w: 275, h: 116 }, B)).toMatchObject({ x: 725, y: 0 });
    expect(clampRect({ x: 10, y: 10, w: 275, h: 116 }, B)).toMatchObject({ x: 10, y: 10 });
  });
  it("pins to the top-left when the desktop is smaller than the window", () => {
    expect(clampRect({ x: 50, y: 50, w: 275, h: 116 }, { w: 200, h: 100 })).toMatchObject({
      x: 0,
      y: 0,
    });
  });
});

describe("docking", () => {
  it("detects touching edges and walks the group", () => {
    const l = defaultLayout(B);
    expect(touching(l.main, l.eq)).toBe(true);
    expect(touching(l.main, l.pl)).toBe(false);
    expect(dockedGroup(l, "main").sort()).toEqual(["eq", "main", "pl"]);
  });
  it("hidden windows are not part of the group", () => {
    const l = defaultLayout(B);
    l.eq.visible = false;
    expect(dockedGroup(l, "main")).toEqual(["main"]);
  });
  it("moves a group without mutating the input", () => {
    const l = defaultLayout(B);
    const m = moveGroup(l, ["main", "eq"], 10, -5);
    expect(m.main.x).toBe(l.main.x + 10);
    expect(m.eq.y).toBe(l.eq.y - 5);
    expect(m.pl).toEqual(l.pl);
  });
});

describe("restoreLayout", () => {
  it("falls back to default for junk", () => {
    expect(restoreLayout("nope", B)).toEqual(defaultLayout(B));
    expect(restoreLayout(null, B)).toEqual(defaultLayout(B));
    expect(restoreLayout({ main: { x: "a" } }, B)).toEqual(defaultLayout(B));
  });
  it("falls back when a saved window is off-screen in this viewport", () => {
    const saved = defaultLayout({ w: 3000, h: 2000 });
    expect(restoreLayout(saved, B)).toEqual(defaultLayout(B));
  });
  it("keeps a valid on-screen layout", () => {
    const l = defaultLayout(B);
    l.pl.visible = false;
    expect(restoreLayout(JSON.parse(JSON.stringify(l)), B)).toEqual(l);
  });
  it("always shows the main window", () => {
    const l = defaultLayout(B);
    l.main.visible = false;
    expect(restoreLayout(l, B).main.visible).toBe(true);
  });
});
