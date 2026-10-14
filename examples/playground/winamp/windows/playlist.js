/** The playlist editor: rows, scrollbar, footer buttons and the running time. */
import { blit } from "../render/blit.js";
import { drawText, formatTime, textWidth } from "../render/text.js";
import { L } from "../skin/sprites.js";

export const VISIBLE_ROWS = 8;
const ROW_H = 10;
const FOOTER = [
  ["plAdd", "plAdd", "Add files", { type: "open" }],
  ["plRem", "plRem", "Remove selected track", { type: "remove" }],
  ["plSel", "plSel", "Select (visual only)", null],
  ["plMisc", "plMisc", "Misc (visual only)", null],
  ["plListBtn", "plList", "List (visual only)", null],
];

export const maxScroll = (count) => Math.max(0, count - VISIBLE_ROWS);

export function createPlaylistWindow({ sheets, palette }) {
  const list = L.plList;
  const rowY = (i) => list.y + 2 + i * ROW_H;

  function draw(ctx, state, ui) {
    blit(ctx, sheets, "plBg", 0, 0);
    blit(ctx, sheets, ui.active ? "plTitleActive" : "plTitleInactive", 0, 0);
    if (ui.pressed === "close") blit(ctx, sheets, "closeBtnDown", L.close.x, L.close.y);

    const { playlist, selection, track } = state;
    const scroll = Math.round(ui.dragging.scroll ?? selection.scroll);
    if (playlist.length === 0) {
      drawText(ctx, sheets, "DROP AUDIO FILES HERE OR PRESS ADD", list.x + 3, rowY(0) + 2, "dim");
    }
    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const idx = scroll + i;
      const entry = playlist[idx];
      if (!entry) break;
      const y = rowY(i);
      if (idx === selection.index) {
        ctx.fillStyle = palette.plSelectedBg;
        ctx.fillRect(list.x, y, list.w, ROW_H);
      }
      const color = track && idx === track.index ? "white" : "green";
      const dur = formatTime(entry.durationSec);
      const dw = textWidth(dur);
      drawText(ctx, sheets, dur, list.x + list.w - 3 - dw, y + 2, color);
      ctx.save();
      ctx.beginPath();
      ctx.rect(list.x, y, list.w - dw - 9, ROW_H);
      ctx.clip();
      drawText(ctx, sheets, `${idx + 1}. ${entry.title}`, list.x + 3, y + 2, color);
      ctx.restore();
    }

    const max = maxScroll(playlist.length);
    const travel = L.plScroll.h - 2 - 18;
    const thumbY = L.plScroll.y + 1 + (max ? Math.round((scroll / max) * travel) : 0);
    blit(ctx, sheets, "plScrollThumb", L.plScroll.x + 1, thumbY);

    for (const [key, name] of FOOTER) {
      blit(ctx, sheets, ui.pressed === key ? `${name}Down` : name, L[key].x, L[key].y);
    }

    const total = playlist.reduce((sum, e) => sum + (e.durationSec || 0), 0);
    const now = track ? state.time.current : 0;
    drawText(
      ctx,
      sheets,
      `${formatTime(now)}/${formatTime(total)}`,
      L.plInfo.x + 3,
      L.plInfo.y + 2,
    );
    const mini = formatTime(now);
    drawText(ctx, sheets, mini, L.plTime.x + L.plTime.w - 2 - textWidth(mini), L.plTime.y + 2);
  }

  function regions(state) {
    const { playlist, selection } = state;
    const out = [
      {
        key: "close",
        kind: "button",
        rect: L.close,
        label: "Close playlist",
        action: { type: "togglePl" },
      },
    ];
    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const idx = selection.scroll + i;
      const entry = playlist[idx];
      if (!entry) break;
      out.push({
        key: `row${idx}`,
        kind: "row",
        rect: { x: list.x, y: rowY(i), w: list.w, h: ROW_H },
        label: `${idx + 1}. ${entry.title}, ${formatTime(entry.durationSec)}`,
        row: { index: idx },
      });
    }
    for (const [key, , label, action] of FOOTER) {
      out.push({ key, kind: "button", rect: L[key], label, action: action ?? { type: "noop" } });
    }
    const max = maxScroll(playlist.length);
    if (max > 0) {
      out.push({
        key: "scroll",
        kind: "range",
        rect: L.plScroll,
        label: "Scroll playlist",
        range: {
          min: 0,
          max,
          step: 1,
          value: max - selection.scroll,
          vertical: true,
          // vertical ranges run bottom to top, the list runs top to bottom
          onInput: (v) => ({ type: "scroll", value: max - v }),
          dragValue: (v) => max - v,
        },
      });
    }
    return out;
  }

  return { id: "pl", width: 275, height: 145, titleHeight: 20, draw, regions };
}
