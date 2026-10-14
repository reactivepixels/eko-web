/**
 * Real, focusable controls laid over each window's canvas: buttons for buttons and playlist
 * rows, range inputs for sliders. They are invisible until focused, so the pixels stay the
 * skin's, while mouse, touch, keyboard and screen readers all go through native elements.
 */

/**
 * @param {HTMLElement} overlay
 * @param {Array<object>} regions
 * @param {number} scale
 * @param {{ onAction: (a: object) => void, onPress: (key: string | null) => void,
 *   onDrag: (key: string, value: number | undefined) => void }} handlers
 */
export function syncHits(overlay, regions, scale, handlers) {
  const els = overlay._hits || (overlay._hits = new Map());
  const seen = new Set();
  for (const region of regions) {
    seen.add(region.key);
    let el = els.get(region.key);
    if (!el || el._kind !== region.kind) {
      el?.remove();
      el = create(region.kind, handlers);
      els.set(region.key, el);
      overlay.appendChild(el);
    }
    el._region = region;
    update(el, region, scale);
  }
  for (const [key, el] of els) {
    if (!seen.has(key)) {
      // A control can vanish mid-drag (the seek bar when the queue empties): release it.
      if (el._dragging) handlers.onDrag(key, undefined);
      el.remove();
      els.delete(key);
    }
  }
}

function create(kind, handlers) {
  const el = document.createElement(kind === "range" ? "input" : "button");
  el._kind = kind;
  el.className = `wa-hit wa-hit-${kind}`;
  if (kind === "range") {
    el.type = "range";
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("input", () => {
      const r = el._region;
      const v = Number(el.value);
      el._dragging = true;
      handlers.onDrag(r.key, r.range.dragValue ? r.range.dragValue(v) : v);
      const action = r.range.onInput(v);
      if (action) handlers.onAction(action);
    });
    // A drag ends on whichever comes first. `change` alone is not enough: browsers skip it
    // when the thumb is released where it started, which would leave the drag stuck.
    const finish = () => {
      if (!el._dragging) return;
      el._dragging = false;
      const r = el._region;
      if (r.range.onCommit) handlers.onAction(r.range.onCommit(Number(el.value)));
      handlers.onDrag(r.key, undefined);
    };
    for (const type of ["change", "pointerup", "pointercancel", "blur"]) {
      el.addEventListener(type, finish);
    }
    return el;
  }
  el.type = "button";
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    handlers.onPress(el._region.key);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    el.addEventListener(type, () => handlers.onPress(null));
  }
  if (kind === "row") {
    el.addEventListener("click", () =>
      handlers.onAction({ type: "select", index: el._region.row.index }),
    );
    el.addEventListener("dblclick", () =>
      handlers.onAction({ type: "playIndex", index: el._region.row.index }),
    );
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      handlers.onAction({ type: "playIndex", index: el._region.row.index });
    });
  } else {
    el.addEventListener("click", () => handlers.onAction(el._region.action));
  }
  return el;
}

function setStyle(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

function update(el, region, scale) {
  const { rect } = region;
  setStyle(el, "left", `${rect.x * scale}px`);
  setStyle(el, "top", `${rect.y * scale}px`);
  setStyle(el, "width", `${rect.w * scale}px`);
  setStyle(el, "height", `${rect.h * scale}px`);
  if (el.getAttribute("aria-label") !== region.label) el.setAttribute("aria-label", region.label);
  if (region.kind !== "range") return;
  const { min, max, step, value, vertical } = region.range;
  if (el.min !== String(min)) el.min = String(min);
  if (el.max !== String(max)) el.max = String(max);
  if (el.step !== String(step)) el.step = String(step);
  el.classList.toggle("wa-hit-vertical", Boolean(vertical));
  // Never fight the pointer: while a drag is live, the element owns its value.
  if (!el._dragging && Number(el.value) !== value) el.value = String(value);
}
