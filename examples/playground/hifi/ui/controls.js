/**
 * Front-panel controls as real, focusable elements. Knobs and faders are ARIA sliders that
 * take a drag, the wheel, arrow keys, Page Up/Down and Home/End; a double-click returns a
 * knob to its detent. Switches and keys are buttons. Each control owns only its own
 * element and reports values; the page decides what they mean.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Snap to the step grid, measured from min, without float dust. */
export function quantize(v, min, max, step) {
  const q = Math.round((v - min) / step) * step + min;
  return clamp(Number(q.toFixed(6)), min, max);
}

/** Map a pixel drag to a value change: a full sweep takes `travel` pixels. */
export function dragValue(start, dx, dy, { min, max, travel }) {
  return clamp(start + ((dx - dy) / travel) * (max - min), min, max);
}

function keyDelta(e, step, big) {
  switch (e.key) {
    case "ArrowUp":
    case "ArrowRight":
      return step;
    case "ArrowDown":
    case "ArrowLeft":
      return -step;
    case "PageUp":
      return big;
    case "PageDown":
      return -big;
    default:
      return 0;
  }
}

/**
 * A rotary or linear slider.
 * @param {HTMLElement} el
 * @param {{ label: string, min: number, max: number, step: number, value: number,
 *   detent?: number, travel?: number, vertical?: boolean, track?: HTMLElement,
 *   format?: (v: number) => string, onInput: (v: number) => void,
 *   render: (v: number) => void }} o
 */
export function slider(el, o) {
  let value = o.value;
  const big = o.bigStep ?? (o.max - o.min) / 10;
  el.tabIndex = 0;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", o.label);
  el.setAttribute("aria-valuemin", String(o.min));
  el.setAttribute("aria-valuemax", String(o.max));
  if (o.vertical) el.setAttribute("aria-orientation", "vertical");

  function show() {
    el.setAttribute("aria-valuenow", String(value));
    el.setAttribute("aria-valuetext", o.format ? o.format(value) : String(value));
    o.render(value);
  }

  function set(v, notify = true) {
    const next = quantize(v, o.min, o.max, o.step);
    if (next === value) return;
    value = next;
    show();
    if (notify) o.onInput(value);
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = value;
    // A fader's cap follows the pointer; a knob turns by how far you drag.
    const rect = o.track?.getBoundingClientRect();
    const fromTrack = (ev) => {
      const f = 1 - (ev.clientY - rect.top) / rect.height;
      return o.min + clamp(f, 0, 1) * (o.max - o.min);
    };
    if (rect) set(fromTrack(e));
    const move = (ev) =>
      set(
        rect
          ? fromTrack(ev)
          : dragValue(start, ev.clientX - sx, ev.clientY - sy, { ...o, travel: o.travel ?? 180 }),
      );
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });

  // The wheel turns a knob only once it has focus (click it first), so scrolling the page
  // past the panel never changes a setting. Trackpads send many small deltas: step per notch.
  let wheelAcc = 0;
  el.addEventListener(
    "wheel",
    (e) => {
      if (document.activeElement !== el || e.deltaY === 0) return;
      e.preventDefault();
      wheelAcc += e.deltaY;
      while (Math.abs(wheelAcc) >= 40) {
        set(value + (wheelAcc < 0 ? o.step : -o.step));
        wheelAcc -= Math.sign(wheelAcc) * 40;
      }
    },
    { passive: false },
  );

  el.addEventListener("keydown", (e) => {
    let next = null;
    const d = keyDelta(e, o.step, big);
    if (d) next = value + d;
    else if (e.key === "Home") next = o.min;
    else if (e.key === "End") next = o.max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  });

  if (o.detent !== undefined) el.addEventListener("dblclick", () => set(o.detent));

  show();
  return {
    get value() {
      return value;
    },
    set: (v) => set(v, false),
  };
}

/**
 * A detented selector (SPEAKERS, INPUT, TAPE MON, tape type): a slider over option indices
 * whose clicks also step to the next position, like nudging a chunky rotary switch.
 */
export function selector(el, o) {
  const { options, labels } = o;
  let dragged = false;
  const s = slider(el, {
    label: o.label,
    min: 0,
    max: options.length - 1,
    step: 1,
    bigStep: 1,
    travel: 90,
    value: Math.max(0, options.indexOf(o.value)),
    format: (i) => labels[options[i]] ?? options[i],
    onInput: (i) => {
      dragged = true;
      o.onInput(options[i]);
    },
    render: (i) => o.render(options[i], i),
  });
  el.addEventListener("pointerdown", () => (dragged = false));
  el.addEventListener("click", () => {
    if (dragged) return;
    const i = (s.value + 1) % options.length;
    s.set(i);
    o.render(options[i], i);
    o.onInput(options[i]);
  });
  return {
    get value() {
      return options[s.value];
    },
    set: (v) => {
      s.set(options.indexOf(v));
      o.render(v, options.indexOf(v));
    },
  };
}

/** A latching switch or push button. */
export function toggle(el, o) {
  let on = o.value;
  el.setAttribute("aria-label", o.label);
  const show = () => {
    el.setAttribute("aria-pressed", String(on));
    o.render(on);
  };
  el.addEventListener("click", () => {
    on = !on;
    show();
    o.onChange(on);
  });
  show();
  return {
    get value() {
      return on;
    },
    set: (v) => {
      on = v;
      show();
    },
  };
}
