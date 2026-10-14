import { describe, expect, it } from "vitest";
import { L, S, SHEETS } from "./sprites.js";

describe("sprites", () => {
  it("every sprite lies inside its sheet", () => {
    for (const [name, s] of Object.entries(S)) {
      const sheet = SHEETS[s.sheet];
      expect(sheet, name).toBeDefined();
      expect(s.x >= 0 && s.y >= 0, name).toBe(true);
      expect(s.x + s.w <= sheet.w && s.y + s.h <= sheet.h, name).toBe(true);
    }
  });
  it("pressed variants match their normal size and sit right under it", () => {
    for (const [name, s] of Object.entries(S)) {
      if (!name.endsWith("Down")) continue;
      const base = S[name.slice(0, -4)];
      expect(base, name).toBeDefined();
      expect([s.w, s.h]).toEqual([base.w, base.h]);
      expect(s.y).toBe(base.y + base.h);
    }
  });
  it("main-window layout rects fit the 275x116 window", () => {
    for (const k of ["vis", "marquee", "volume", "balance", "posbar", "shuffle", "repeat"]) {
      const r = L[k];
      expect(r.x + r.w <= 275 && r.y + r.h <= 116, k).toBe(true);
    }
  });
  it("sprites placed by layout match the layout size", () => {
    expect([S.btnPlay.w, S.btnPlay.h]).toEqual([L.play.w, L.play.h]);
    expect([S.shuffleOn.w, S.shuffleOn.h]).toEqual([L.shuffle.w, L.shuffle.h]);
    expect([S.vol0.w, S.vol0.h]).toEqual([L.volume.w, L.volume.h]);
    expect([S.plAdd.w, S.plAdd.h]).toEqual([L.plAdd.w, L.plAdd.h]);
  });
});
