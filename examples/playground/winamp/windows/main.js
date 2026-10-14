/** The main window: LCD, visualiser, marquee, readouts, sliders and transport. */
import { blit, blitPart } from "../render/blit.js";
import { drawText, drawTime, formatTime, textWidth } from "../render/text.js";
import { L, VOLUME_FRAMES } from "../skin/sprites.js";

const TRANSPORT = [
  ["prev", "btnPrev", "Previous track", { type: "prev" }],
  ["play", "btnPlay", "Play", { type: "play" }],
  ["pause", "btnPause", "Pause", { type: "pause" }],
  ["stop", "btnStop", "Stop", { type: "stop" }],
  ["next", "btnNext", "Next track", { type: "next" }],
  ["eject", "btnEject", "Open files", { type: "open" }],
];

const MARQUEE_SPEED = 22;

export function createMainWindow({ sheets, palette }) {
  const sprite = (ctx, name, rect, down) =>
    blit(ctx, sheets, down ? `${name}Down` : name, rect.x, rect.y);

  function drawVis(ctx, vis) {
    const { x, y } = L.vis;
    if (vis.mode === "spectrum") {
      for (let i = 0; i < vis.bars.length; i++) {
        const h = Math.round(vis.bars[i]);
        for (let r = 0; r < h; r++) {
          const row = 15 - r;
          ctx.fillStyle = palette.vis[row];
          ctx.fillRect(x + i * 4, y + row, 3, 1);
        }
        const p = Math.round(vis.peaks[i]);
        if (p > 0) {
          ctx.fillStyle = palette.peak;
          ctx.fillRect(x + i * 4, y + 16 - p, 3, 1);
        }
      }
    } else if (vis.mode === "scope") {
      let prev = vis.scope[0];
      for (let i = 0; i < vis.scope.length; i++) {
        const cur = vis.scope[i];
        const top = Math.min(prev, cur);
        const bottom = Math.max(prev, cur);
        ctx.fillStyle = palette.vis[15 - Math.min(15, Math.abs(cur - 8) * 2)];
        ctx.fillRect(x + i, y + top, 1, bottom - top + 1);
        prev = cur;
      }
    }
  }

  function marqueeText(state) {
    if (state.error) return state.error;
    if (!state.track) return "EKO-AMP *** DROP AUDIO FILES ANYWHERE OR PRESS PLAY";
    const { index, title } = state.track;
    return `${index + 1}. ${title} (${formatTime(state.time.duration)})`;
  }

  function drawMarquee(ctx, state) {
    const r = L.marquee;
    const text = marqueeText(state);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (textWidth(text) <= r.w - 4) {
      drawText(ctx, sheets, text, r.x + 2, 27);
    } else {
      const loop = `${text}  ***  `;
      const w = textWidth(loop);
      const off = Math.floor((state.now / 1000) * MARQUEE_SPEED) % w;
      drawText(ctx, sheets, loop, r.x + 2 - off, 27);
      drawText(ctx, sheets, loop, r.x + 2 - off + w, 27);
    }
    ctx.restore();
  }

  function draw(ctx, state, ui) {
    const pressed = (key) => ui.pressed === key;
    blit(ctx, sheets, "mainBg", 0, 0);
    blit(ctx, sheets, ui.active ? "titleActive" : "titleInactive", 0, 0);
    if (pressed("close")) sprite(ctx, "closeBtn", L.close, true);

    // status indicator and time; the time blinks while paused, as it did
    const { status, time, track } = state;
    if (track) {
      const ind = status === "playing" ? "playInd" : status === "paused" ? "pauseInd" : "stopInd";
      blit(ctx, sheets, ind, L.playInd.x, L.playInd.y);
    }
    const blinkOff = status === "paused" && Math.floor(state.now / 500) % 2 === 1;
    if (track && status !== "stopped" && !blinkOff) {
      const remaining = time.showRemaining && time.duration > 0;
      const shown = remaining ? time.duration - time.current : time.current;
      drawTime(ctx, sheets, shown, L.time.x, L.time.y, remaining);
      ctx.fillStyle = palette.lcd;
      ctx.fillRect(72, 30, 2, 2);
      ctx.fillRect(72, 35, 2, 2);
    }
    drawVis(ctx, state.vis);
    drawMarquee(ctx, state);

    if (track) {
      if (track.kbps)
        drawText(ctx, sheets, String(Math.min(999, track.kbps)).padStart(3, " "), 110, 42);
      if (track.khz) drawText(ctx, sheets, String(Math.round(track.khz)).slice(0, 2), 154, 42);
    }
    blit(ctx, sheets, "mono", L.mono.x, L.mono.y);
    blit(ctx, sheets, status === "playing" ? "stereoLit" : "stereo", L.stereo.x, L.stereo.y);

    const vol = ui.dragging.volume ?? state.volume;
    blit(ctx, sheets, `vol${Math.round(vol * (VOLUME_FRAMES - 1))}`, L.volume.x, L.volume.y);
    sprite(ctx, "volThumb", { x: 108 + Math.round(vol * 52), y: 58 }, "volume" in ui.dragging);
    const bal = ui.dragging.balance ?? state.balance;
    blit(ctx, sheets, "balBg", L.balance.x, L.balance.y);
    sprite(ctx, "balThumb", { x: 189 + Math.round(bal * 12), y: 58 }, "balance" in ui.dragging);

    blit(ctx, sheets, state.windows.eq ? "eqToggleOn" : "eqToggleOff", L.eqToggle.x, L.eqToggle.y);
    blit(ctx, sheets, state.windows.pl ? "plToggleOn" : "plToggleOff", L.plToggle.x, L.plToggle.y);

    if (track && time.duration > 0) {
      const at = ui.dragging.posbar ?? time.current;
      const px = 17 + Math.round(Math.min(1, Math.max(0, at / time.duration)) * 217);
      blitPart(ctx, sheets, "posFill", px - 17, 17, 76);
      sprite(ctx, "posThumb", { x: px, y: 72 }, "posbar" in ui.dragging);
    }

    for (const [key, name] of TRANSPORT) sprite(ctx, name, L[key], pressed(key));
    blit(ctx, sheets, state.shuffle ? "shuffleOn" : "shuffleOff", L.shuffle.x, L.shuffle.y);
    blit(ctx, sheets, state.repeat ? "repeatOn" : "repeatOff", L.repeat.x, L.repeat.y);
  }

  function regions(state) {
    const list = TRANSPORT.map(([key, , label, action]) => ({
      key,
      kind: "button",
      rect: L[key],
      label,
      action,
    }));
    list.push(
      {
        key: "shuffle",
        kind: "button",
        rect: L.shuffle,
        label: "Shuffle",
        action: { type: "shuffle" },
      },
      {
        key: "repeat",
        kind: "button",
        rect: L.repeat,
        label: "Repeat",
        action: { type: "repeat" },
      },
      {
        key: "eqToggle",
        kind: "button",
        rect: L.eqToggle,
        label: "Show equalizer",
        action: { type: "toggleEq" },
      },
      {
        key: "plToggle",
        kind: "button",
        rect: L.plToggle,
        label: "Show playlist",
        action: { type: "togglePl" },
      },
      {
        key: "time",
        kind: "button",
        rect: L.time,
        label: "Toggle elapsed or remaining time",
        action: { type: "toggleTime" },
      },
      {
        key: "vis",
        kind: "button",
        rect: L.vis,
        label: "Switch visualiser",
        action: { type: "toggleVis" },
      },
      {
        key: "volume",
        kind: "range",
        rect: L.volume,
        label: "Volume",
        range: {
          min: 0,
          max: 1,
          step: 0.01,
          value: state.volume,
          onInput: (value) => ({ type: "volume", value }),
        },
      },
      {
        key: "balance",
        kind: "range",
        rect: L.balance,
        label: "Balance",
        range: {
          min: -1,
          max: 1,
          step: 0.02,
          value: state.balance,
          onInput: (value) => ({ type: "balance", value }),
        },
      },
    );
    if (state.track && state.time.duration > 0) {
      list.push({
        key: "posbar",
        kind: "range",
        rect: L.posbar,
        label: "Seek",
        range: {
          min: 0,
          max: state.time.duration,
          step: 0.1,
          value: state.time.current,
          onInput: () => null,
          onCommit: (value) => ({ type: "seek", value }),
        },
      });
    }
    return list;
  }

  return { id: "main", width: 275, height: 116, titleHeight: 14, draw, regions };
}
