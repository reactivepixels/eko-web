/**
 * The pure parts of the desktop: where a dragged window may go, how times and the clock
 * read, how a filename becomes a title and an artist, which tray balloon is showing, and
 * what the transport reads.
 */

/**
 * Keep a window fully on the desktop, above the taskbar. If the desktop is smaller than the
 * window, the window's top-left corner wins, so the title bar stays reachable.
 * @param {{ x: number, y: number, w: number, h: number }} win
 * @param {{ w: number, h: number }} desk  the area above the taskbar
 */
export function clampWindow(win, desk) {
  const x = Math.max(0, Math.min(win.x, desk.w - win.w));
  const y = Math.max(0, Math.min(win.y, desk.h - win.h));
  return { ...win, x, y };
}

/** 107 seconds is "1:47"; an hour or more is "1:02:03". */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** The taskbar clock: "4:20 PM". */
export function formatClock(date) {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * Split a filename-style title into what the display shows. "Artist - Title" gives an
 * artist; a leading track number ("07 " or "07. ") is dropped; and a title like "Ember Set
 * II. Relay" reads as part II of an album called "Ember Set".
 * @returns {{ title: string, artist: string, album: string }}
 */
export function parseTitle(raw) {
  let text = String(raw)
    .trim()
    .replace(/^\d{1,3}[\s.\-_]+(?=\S)/, "");
  let artist = "";
  const dash = text.indexOf(" - ");
  if (dash > 0) {
    artist = text.slice(0, dash).trim();
    text = text.slice(dash + 3).trim();
  }
  let album = "";
  const part = /^(.+?)\s+([IVX]+)\.\s+(.+)$/.exec(text);
  if (part) {
    album = part[1];
    text = part[3];
  }
  return { title: text || String(raw), artist, album };
}

/**
 * Tray balloons. One shows at a time and the newest wins; the same track announced twice
 * in quick succession (a skip and its trackchange) shows once.
 */
export const BALLOON_MS = 7000;

export function createBalloons() {
  return { current: null, shownAt: 0, lastKey: null, lastAt: -Infinity };
}

/** Show a balloon. `key` identifies what it is about, for the duplicate check. */
export function showBalloon(state, balloon, key, now) {
  if (key !== undefined && key === state.lastKey && now - state.lastAt < 2000) return state;
  state.current = balloon;
  state.shownAt = now;
  state.lastKey = key;
  state.lastAt = now;
  return state;
}

/** Expire the balloon once it has been up long enough. Returns whether it changed. */
export function tickBalloons(state, now) {
  if (state.current && now - state.shownAt >= BALLOON_MS) {
    state.current = null;
    return true;
  }
  return false;
}

export function dismissBalloon(state) {
  state.current = null;
  return state;
}

/**
 * The transport as the window shows it. It follows the engine's own events, so the media
 * keys and the lock screen (which drive the engine directly) keep the window in step. The
 * only thing kept locally is intent the engine cannot tell apart: stopped (rewound, ready
 * to start over) versus paused, and whether the queue ran off its end.
 */
export function createTransport() {
  return { stopped: true, paused: false, ended: false };
}

/**
 * Apply one event: the engine's "play", "pause" and "ended", or the window's own "stop"
 * (the Stop button) and "moved" (a seek or skip, which takes the tape off its end).
 */
export function transportEvent(t, type) {
  switch (type) {
    case "play":
      t.stopped = false;
      t.paused = false;
      t.ended = false;
      break;
    case "pause":
      // Stop pauses the engine too: that is still stopped, not paused.
      if (!t.stopped) t.paused = true;
      break;
    case "ended":
      t.stopped = true;
      t.paused = false;
      t.ended = true;
      break;
    case "stop":
      t.stopped = true;
      t.paused = false;
      break;
    case "moved":
      t.ended = false;
      break;
    default:
      break;
  }
  return t;
}

export const isPlaying = (t) => !t.stopped && !t.paused;

/** The status bar word. */
export function transportLabel(t, hasTracks) {
  if (isPlaying(t)) return "Playing";
  if (t.paused) return "Paused";
  return hasTracks ? "Stopped" : "Ready";
}

/**
 * Spectrum bars from analyser bytes: `count` bars on a log frequency scale from about 40 Hz
 * to 16 kHz, each the loudest bin in its slice, 0..1.
 */
export function spectrumBars(bytes, sampleRate, fftSize, count, out = new Float32Array(count)) {
  const hz = sampleRate / fftSize;
  const lo = Math.log(40);
  const hi = Math.log(16000);
  for (let i = 0; i < count; i++) {
    const a = Math.max(1, Math.floor(Math.exp(lo + ((hi - lo) * i) / count) / hz));
    const b = Math.max(a + 1, Math.floor(Math.exp(lo + ((hi - lo) * (i + 1)) / count) / hz));
    let max = 0;
    for (let k = a; k < b && k < bytes.length; k++) max = Math.max(max, bytes[k]);
    out[i] = max / 255;
  }
  return out;
}
