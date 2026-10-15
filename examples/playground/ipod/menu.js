/**
 * The menu stack. Each screen knows how to build its rows from the library and settings at
 * the moment it is drawn, so a new sync or a changed setting shows up without rebuilding the
 * stack. Selecting a row either opens another screen or hands an action back to the page.
 */

/** Rows that fit under the title bar. */
export const VISIBLE_ROWS = 9;

export const SETTINGS = {
  shuffle: { label: "Shuffle", values: ["Off", "Songs"] },
  repeat: { label: "Repeat", values: ["Off", "One", "All"] },
  clicker: { label: "Clicker", values: ["Off", "On"] },
};

/** @typedef {{ label: string, detail?: string, chevron?: boolean, action?: object }} Row */

const screen = (id, title, build) => ({ id, title, build, sel: 0, top: 0 });

export function mainMenu() {
  return screen("main", "EKO", (ctx) => {
    const rows = [
      { label: "Music", chevron: true, action: { type: "open", screen: musicMenu() } },
      { label: "Shuffle Songs", action: { type: "shuffleAll" } },
      { label: "Settings", chevron: true, action: { type: "open", screen: settingsMenu() } },
    ];
    if (ctx.nowPlaying) rows.push({ label: "Now Playing", chevron: true, action: { type: "now" } });
    return rows;
  });
}

export function musicMenu() {
  return screen("music", "Music", (ctx) => [
    { label: "Artists", chevron: true, action: { type: "open", screen: artistsMenu() } },
    { label: "Albums", chevron: true, action: { type: "open", screen: albumsMenu() } },
    {
      label: "Songs",
      chevron: true,
      action: { type: "open", screen: songsMenu("Songs", (c) => c.library.songs) },
    },
    ...(ctx.library.songs.length ? [] : [{ label: "Sync some music first" }]),
  ]);
}

/** A list of songs: selecting one plays the whole list from there. */
export function songsMenu(title, pick) {
  return screen(`songs:${title}`, title, (ctx) => {
    const songs = pick(ctx);
    if (!songs.length) return [{ label: "No songs" }];
    return songs.map((s, i) => ({ label: s.name, action: { type: "play", songs, index: i } }));
  });
}

export function artistsMenu() {
  return screen("artists", "Artists", (ctx) => {
    if (!ctx.library.artists.length) return [{ label: "No artists" }];
    return ctx.library.artists.map((a) => ({
      label: a.name,
      chevron: true,
      action: {
        type: "open",
        screen: songsMenu(
          a.name,
          (c) => c.library.artists.find((x) => x.name === a.name)?.songs ?? [],
        ),
      },
    }));
  });
}

export function albumsMenu() {
  return screen("albums", "Albums", (ctx) => {
    if (!ctx.library.albums.length) return [{ label: "No albums" }];
    return ctx.library.albums.map((a) => ({
      label: a.name,
      chevron: true,
      action: {
        type: "open",
        screen: songsMenu(
          a.name,
          (c) => c.library.albums.find((x) => x.name === a.name)?.songs ?? [],
        ),
      },
    }));
  });
}

export function settingsMenu() {
  return screen("settings", "Settings", (ctx) => [
    ...Object.entries(SETTINGS).map(([key, s]) => ({
      label: s.label,
      detail: s.values[ctx.settings[key]],
      action: { type: "setting", key },
    })),
    { label: "About", chevron: true, action: { type: "open", screen: aboutMenu() } },
  ]);
}

export function aboutMenu() {
  return screen("about", "About", (ctx) => [
    { label: "Songs", detail: String(ctx.library.songs.length) },
    { label: "Artists", detail: String(ctx.library.artists.length) },
    { label: "Albums", detail: String(ctx.library.albums.length) },
    { label: "Playback", detail: "Gapless" },
    { label: "Engine", detail: "EKO Web" },
  ]);
}

export const nowPlayingScreen = () => ({ id: "now", title: "Now Playing", now: true });

/** Next value of a setting, wrapping. */
export function cycleSetting(settings, key) {
  const n = SETTINGS[key].values.length;
  return { ...settings, [key]: (settings[key] + 1) % n };
}

/**
 * The navigation state: a stack of screens with a selection each.
 * @param {() => object} context  returns { library, settings, nowPlaying } when called
 */
export function createNav(context) {
  const stack = [mainMenu()];
  const top = () => stack[stack.length - 1];

  function rows() {
    const s = top();
    return s.now ? [] : s.build(context());
  }

  /** Keep the selection on a real row and the window around it. */
  function clamp() {
    const s = top();
    if (s.now) return;
    const n = rows().length;
    s.sel = Math.max(0, Math.min(n - 1, s.sel));
    if (s.sel < s.top) s.top = s.sel;
    if (s.sel >= s.top + VISIBLE_ROWS) s.top = s.sel - VISIBLE_ROWS + 1;
    s.top = Math.max(0, Math.min(Math.max(0, n - VISIBLE_ROWS), s.top));
  }

  return {
    get screen() {
      return top();
    },
    get depth() {
      return stack.length;
    },
    rows,
    /** Move the selection; returns true if it moved. */
    scroll(steps) {
      const s = top();
      if (s.now || !steps) return false;
      const before = s.sel;
      s.sel += steps;
      clamp();
      return s.sel !== before;
    },
    /**
     * Select the highlighted row. Opens a screen itself; anything else comes back as an
     * action for the page to carry out. Returns null when the row does nothing.
     */
    select() {
      const s = top();
      if (s.now) return null;
      const row = rows()[s.sel];
      const action = row?.action;
      if (!action) return null;
      if (action.type === "open") {
        stack.push({ ...action.screen, sel: 0, top: 0 });
        return { type: "pushed" };
      }
      return action;
    },
    push(next) {
      if (top().id === next.id) return;
      stack.push(next);
      clamp();
    },
    /** MENU: back one screen. Returns false at the top. */
    back() {
      if (stack.length === 1) return false;
      stack.pop();
      clamp();
      return true;
    },
    /** After the library changes, drop to the main menu if a screen lost its rows. */
    refresh() {
      clamp();
    },
  };
}
