/** The equalizer window: ON/AUTO, presets, the response curve, preamp and ten bands. */
import { blit } from "../render/blit.js";
import { L } from "../skin/sprites.js";

const LABELS = [
  "60 Hz",
  "170 Hz",
  "310 Hz",
  "600 Hz",
  "1 kHz",
  "3 kHz",
  "6 kHz",
  "12 kHz",
  "14 kHz",
  "16 kHz",
];
const SLIDER_TOP = 38;

export function createEqWindow({ sheets, palette }) {
  const rampColor = (db) => palette.eqRamp[Math.round(Math.max(-12, Math.min(12, db))) + 12];

  /** One vertical slider: coloured fill from the centre line to the thumb, then the thumb. */
  function slider(ctx, x, db, down) {
    const cy = SLIDER_TOP + 31;
    const ty = SLIDER_TOP + 26 - Math.round((db / 12) * 26);
    const top = Math.min(cy, ty + 5);
    const bottom = Math.max(cy, ty + 5);
    ctx.fillStyle = rampColor(db);
    ctx.fillRect(x + 5, top, 4, bottom - top + 1);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(x + 5, top, 1, bottom - top + 1);
    ctx.fillStyle = palette.eqCenter;
    ctx.fillRect(x + 1, cy, 12, 1);
    blit(ctx, sheets, down ? "eqSliderThumbDown" : "eqSliderThumb", x + 1, ty);
  }

  /** Winamp drew the curve as a spline through the bands; Catmull-Rom is close enough to it. */
  function curve(ctx, bands, preamp) {
    const g = L.eqGraph;
    const mid = g.y + 9;
    ctx.fillStyle = palette.eqPreampLine;
    const py = mid - Math.round((preamp / 12) * 8);
    for (let x = g.x + 2; x < g.x + g.w - 2; x += 3) ctx.fillRect(x, py, 2, 1);
    let prevY = null;
    for (let x = 0; x < 109; x++) {
      const fx = (x / 108) * 9;
      const i = Math.min(8, Math.floor(fx));
      const f = fx - i;
      const p0 = bands[Math.max(0, i - 1)];
      const p1 = bands[i];
      const p2 = bands[i + 1];
      const p3 = bands[Math.min(9, i + 2)];
      const v =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * f +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
          (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
      const y = mid - Math.round((v / 12) * 8);
      const from = prevY === null ? y : prevY;
      ctx.fillStyle = rampColor(v);
      ctx.fillRect(g.x + 2 + x, Math.min(from, y), 1, Math.abs(from - y) + 1);
      prevY = y;
    }
  }

  function draw(ctx, state, ui) {
    const { eq } = state;
    const bandValue = (i) => ui.dragging[`band${i}`] ?? eq.bands[i];
    const bands = eq.bands.map((_, i) => bandValue(i));
    const preamp = ui.dragging.preamp ?? eq.preamp;
    blit(ctx, sheets, "eqBg", 0, 0);
    blit(ctx, sheets, ui.active ? "eqTitleActive" : "eqTitleInactive", 0, 0);
    if (ui.pressed === "close") blit(ctx, sheets, "closeBtnDown", L.close.x, L.close.y);
    blit(ctx, sheets, eq.on ? "eqOnOn" : "eqOnOff", L.eqOn.x, L.eqOn.y);
    blit(ctx, sheets, eq.auto ? "eqAutoOn" : "eqAutoOff", L.eqAuto.x, L.eqAuto.y);
    blit(
      ctx,
      sheets,
      ui.pressed === "presets" ? "presetsDown" : "presets",
      L.presets.x,
      L.presets.y,
    );
    curve(ctx, bands, preamp);
    slider(ctx, L.preamp.x, preamp, "preamp" in ui.dragging);
    bands.forEach((db, i) =>
      slider(ctx, L.band0.x + i * L.bandStep.x, db, `band${i}` in ui.dragging),
    );
  }

  const vertical = (key, x, label, value, type, extra = {}) => ({
    key,
    kind: "range",
    rect: { x: x + 1, y: SLIDER_TOP, w: 12, h: 63 },
    label,
    range: {
      min: -12,
      max: 12,
      step: 0.5,
      value,
      vertical: true,
      onInput: (v) => ({ type, value: v, ...extra }),
    },
  });

  function regions(state) {
    const { eq } = state;
    return [
      {
        key: "close",
        kind: "button",
        rect: L.close,
        label: "Close equalizer",
        action: { type: "toggleEq" },
      },
      {
        key: "eqOn",
        kind: "button",
        rect: L.eqOn,
        label: "Equalizer on",
        action: { type: "eqOn" },
      },
      {
        key: "eqAuto",
        kind: "button",
        rect: L.eqAuto,
        label: "Auto (visual only)",
        action: { type: "eqAuto" },
      },
      {
        key: "presets",
        kind: "button",
        rect: L.presets,
        label: "Next preset",
        action: { type: "eqPreset" },
      },
      vertical("preamp", L.preamp.x, "Preamp", eq.preamp, "preamp"),
      ...eq.bands.map((db, i) =>
        vertical(`band${i}`, L.band0.x + i * L.bandStep.x, `EQ ${LABELS[i]}`, db, "eqBand", {
          index: i,
        }),
      ),
    ];
  }

  return { id: "eq", width: 275, height: 116, titleHeight: 14, draw, regions };
}
