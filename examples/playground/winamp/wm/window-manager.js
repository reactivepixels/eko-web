/**
 * Puts the three windows on the desktop and moves them like Winamp did: drag by the
 * titlebar, snap to edges, and drag the main window to carry everything docked to it.
 */
import { createSurface, present } from "../render/blit.js";
import { clampRect, dockedGroup, moveGroup, restoreLayout, snapRect } from "./geometry.js";
import { syncHits } from "./hit-layer.js";

const pickScale = () => (innerWidth >= 700 && innerHeight >= 800 ? 2 : 1);

export function createWindowManager({ desktop, windows, onAction, storageKey }) {
  let scale = pickScale();
  let activeId = "main";
  const order = windows.map((w) => w.id);
  const ui = Object.fromEntries(windows.map((w) => [w.id, { pressed: null, dragging: {} }]));

  const bounds = () => ({
    w: Math.floor(desktop.clientWidth / scale),
    h: Math.floor(desktop.clientHeight / scale),
  });

  let layout = restoreLayout(load(), bounds());

  function load() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      // Private mode or blocked storage: positions just won't persist.
    }
  }

  const views = windows.map((win) => {
    const el = document.createElement("div");
    el.className = "wa-win";
    el.dataset.id = win.id;
    const canvas = document.createElement("canvas");
    canvas.className = "wa-canvas";
    const hits = document.createElement("div");
    hits.className = "wa-hits";
    el.append(canvas, hits);
    desktop.appendChild(el);
    const surface = createSurface(win.width, win.height);
    const handlers = {
      onAction: (a) => a && onAction(a),
      onPress: (key) => (ui[win.id].pressed = key),
      onDrag: (key, value) => {
        if (value === undefined) delete ui[win.id].dragging[key];
        else ui[win.id].dragging[key] = value;
      },
    };
    el.addEventListener("pointerdown", (e) => startDrag(e, win));
    return { win, el, canvas, hits, surface, handlers };
  });

  function raise(id) {
    activeId = id;
    order.splice(order.indexOf(id), 1);
    order.push(id);
  }

  function position() {
    for (const v of views) {
      const r = layout[v.win.id];
      v.el.style.display = r.visible ? "" : "none";
      v.el.style.left = `${r.x * scale}px`;
      v.el.style.top = `${r.y * scale}px`;
      v.el.style.zIndex = String(10 + order.indexOf(v.win.id));
    }
  }

  function startDrag(e, win) {
    raise(win.id);
    position();
    if (e.button !== 0 || e.target.closest(".wa-hit")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if ((e.clientY - rect.top) / scale >= win.titleHeight) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const group = win.id === "main" ? dockedGroup(layout, "main") : [win.id];
    const start = layout;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev) => {
      const dx = Math.round((ev.clientX - sx) / scale);
      const dy = Math.round((ev.clientY - sy) / scale);
      const moved = moveGroup(start, group, dx, dy);
      const rects = group.map((id) => moved[id]);
      const box = {
        x: Math.min(...rects.map((r) => r.x)),
        y: Math.min(...rects.map((r) => r.y)),
      };
      box.w = Math.max(...rects.map((r) => r.x + r.w)) - box.x;
      box.h = Math.max(...rects.map((r) => r.y + r.h)) - box.y;
      const others = Object.keys(layout)
        .filter((id) => !group.includes(id) && layout[id].visible)
        .map((id) => layout[id]);
      const snapped = clampRect(snapRect(box, others, bounds()), bounds());
      layout = moveGroup(start, group, dx + snapped.x - box.x, dy + snapped.y - box.y);
      position();
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      save();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  for (const type of ["dragenter", "dragover"]) {
    document.addEventListener(type, (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
  }
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    onAction({ type: "drop", files: [...e.dataTransfer.files] });
  });

  // Focus rings only while tabbing. Winamp is driven by shortcut keys, and any key press would
  // otherwise light up whichever control was last clicked.
  document.addEventListener("pointerdown", () => desktop.classList.add("wa-pointer"), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab") desktop.classList.remove("wa-pointer");
  });

  addEventListener("resize", () => {
    scale = pickScale();
    layout = restoreLayout(layout, bounds());
    position();
  });

  position();

  return {
    render(state) {
      for (const v of views) {
        if (!layout[v.win.id].visible) continue;
        const u = { ...ui[v.win.id], active: activeId === v.win.id };
        v.win.draw(v.surface.ctx, state, u);
        present(v.surface.canvas, v.canvas, scale);
        syncHits(v.hits, v.win.regions(state, u), scale, v.handlers);
      }
    },
    setVisible(id, visible) {
      layout = { ...layout, [id]: { ...layout[id], visible } };
      if (visible) {
        raise(id);
        layout = restoreLayout(layout, bounds());
      }
      position();
      save();
    },
    isVisible: (id) => layout[id].visible,
  };
}
