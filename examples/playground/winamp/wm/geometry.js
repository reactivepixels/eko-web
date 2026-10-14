/** Pure window maths: snapping, docking and layout persistence, all in skin pixels. */

export const SNAP = 10;
const SIZES = { main: [275, 116], eq: [275, 116], pl: [275, 145] };
const IDS = ["main", "eq", "pl"];

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/** Pick the candidate nearest to `from`, if any is within SNAP. */
function nearest(from, candidates) {
  let best = from;
  let bestD = SNAP + 1;
  for (const c of candidates) {
    const d = Math.abs(c - from);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Snap a moving rect's edges to other windows (flush or aligned) and to the desktop edges.
 * A window only offers x candidates when it is level with the moving rect, and y candidates
 * when it is beside it, so nothing snaps to a window across the screen.
 */
export function snapRect(moving, others, bounds) {
  const { x, y, w, h } = moving;
  const xs = [0, bounds.w - w];
  const ys = [0, bounds.h - h];
  for (const o of others) {
    if (overlap(y - SNAP, y + h + SNAP, o.y, o.y + o.h) > 0) {
      xs.push(o.x + o.w, o.x - w, o.x, o.x + o.w - w);
    }
    if (overlap(x - SNAP, x + w + SNAP, o.x, o.x + o.w) > 0) {
      ys.push(o.y + o.h, o.y - h, o.y, o.y + o.h - h);
    }
  }
  return { ...moving, x: nearest(x, xs), y: nearest(y, ys) };
}

/** Keep a rect fully on the desktop (top-left wins when the desktop is smaller). */
export function clampRect(rect, bounds) {
  return {
    ...rect,
    x: Math.max(0, Math.min(rect.x, bounds.w - rect.w)),
    y: Math.max(0, Math.min(rect.y, bounds.h - rect.h)),
  };
}

/** True when two rects share an edge with some overlap along it. */
export function touching(a, b) {
  const hEdge =
    (a.y + a.h === b.y || b.y + b.h === a.y) && overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0;
  const vEdge =
    (a.x + a.w === b.x || b.x + b.w === a.x) && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > 0;
  return hEdge || vEdge;
}

/** The root window plus every visible window docked to it, directly or through another. */
export function dockedGroup(layout, rootId) {
  const group = [rootId];
  for (let i = 0; i < group.length; i++) {
    for (const id of IDS) {
      if (group.includes(id) || !layout[id].visible) continue;
      if (touching(layout[group[i]], layout[id])) group.push(id);
    }
  }
  return group;
}

export function moveGroup(layout, ids, dx, dy) {
  const next = { ...layout };
  for (const id of ids) next[id] = { ...layout[id], x: layout[id].x + dx, y: layout[id].y + dy };
  return next;
}

/** Main, EQ and playlist stacked and docked, centred on the desktop. */
export function defaultLayout(bounds) {
  const total = SIZES.main[1] + SIZES.eq[1] + SIZES.pl[1];
  const x = Math.max(0, Math.round((bounds.w - 275) / 2));
  const top = Math.max(0, Math.round((bounds.h - total) / 2));
  return {
    main: { x, y: top, w: 275, h: 116, visible: true },
    eq: { x, y: top + 116, w: 275, h: 116, visible: true },
    pl: { x, y: top + 232, w: 275, h: 145, visible: true },
  };
}

/**
 * A saved layout, validated against this viewport. Anything malformed, or any visible window
 * that would land off-screen, gives the default layout instead.
 */
export function restoreLayout(saved, bounds) {
  const fallback = defaultLayout(bounds);
  if (!saved || typeof saved !== "object") return fallback;
  const out = {};
  for (const id of IDS) {
    const r = saved[id];
    if (!r || ![r.x, r.y].every(Number.isFinite) || typeof r.visible !== "boolean") {
      return fallback;
    }
    const [w, h] = SIZES[id];
    const visible = id === "main" ? true : r.visible;
    const onScreen = r.x >= 0 && r.y >= 0 && r.x + w <= bounds.w && r.y + h <= bounds.h;
    if (visible && !onScreen) return fallback;
    out[id] = { x: r.x, y: r.y, w, h, visible };
  }
  return out;
}
