/**
 * The two contestants. Both play the same two files back to back, at the same level, into
 * the same capture point.
 *
 * The bare tag gets its best case: two <audio> elements, the second fully buffered before
 * anything starts, and play() called on it the instant the first one fires `ended`. That is
 * as good as a page can do without Web Audio scheduling.
 *
 * EKO gets the engine as any page would use it, with loudness normalization off so the two
 * cannot be told apart by level.
 */

/** Enough buffered to play. Gives up after `ms` instead of waiting forever (iOS may not preload). */
function ready(el, ms = 6000) {
  return new Promise((resolve, reject) => {
    if (el.readyState >= 3) return resolve();
    let timer = 0;
    const done = (fn, arg) => {
      clearTimeout(timer);
      el.removeEventListener("canplay", ok);
      el.removeEventListener("error", bad);
      fn(arg);
    };
    const ok = () => done(resolve);
    const bad = () => done(reject, el.error || new Error("load"));
    timer = setTimeout(() => done(reject, new Error("timeout")), ms);
    el.addEventListener("canplay", ok);
    el.addEventListener("error", bad);
    el.load();
  });
}

export function createTagPlayer(ctx, out) {
  const els = [new Audio(), new Audio()];
  for (const el of els) {
    el.preload = "auto";
    ctx.createMediaElementSource(el).connect(out);
  }
  let token = 0;
  let unlocked = false;

  function stop() {
    token += 1;
    for (const el of els) {
      el.onended = null;
      el.pause();
    }
  }

  return {
    /**
     * Call inside the click, before any await. WebKit only lets an element start later
     * (the second file, on the first one's `ended`) if it has played from a gesture once.
     */
    unlock(urls) {
      if (unlocked) return;
      unlocked = true;
      els.forEach((el, i) => {
        if (urls) el.src = urls[i];
      });
      for (const el of els) {
        el.muted = true;
        el.play()
          .catch(() => {})
          .finally(() => {
            el.pause();
            el.muted = false;
          });
      }
    },
    /**
     * Play the pair. `done` fires when the second file ends; `fail` if either will not load
     * or play. Neither fires after stop().
     */
    async play(urls, done, fail) {
      stop();
      const mine = token;
      try {
        els.forEach((el, i) => {
          el.src = urls[i];
        });
        await Promise.all(els.map((el) => ready(el)));
        if (mine !== token) return;
        els.forEach((el) => (el.currentTime = 0));
        els[0].onended = () => {
          if (mine !== token) return;
          els[1].play().catch((err) => mine === token && fail(err));
        };
        els[1].onended = () => {
          if (mine === token) done();
        };
        await els[0].play();
      } catch (err) {
        if (mine === token) fail(err);
      }
    },
    stop,
    /** Seconds into the pair. */
    position() {
      const [a, b] = els;
      if (!a.ended && b.currentTime === 0) return a.currentTime;
      return (a.duration || 0) + b.currentTime;
    },
  };
}

export function createEkoPlayer(engine) {
  let token = 0;
  let onDone = null;
  let onFail = null;
  engine.on("ended", () => {
    const done = onDone;
    onDone = onFail = null;
    done?.();
  });
  // Load and decode failures arrive as events, not as a rejected play(). A failed prefetch
  // still plays (with a gap), so only a hard failure ends the audition.
  engine.on("error", ({ error }) => {
    if (error.code === "prefetch_failed") return;
    const fail = onFail;
    onDone = onFail = null;
    fail?.(error);
  });
  return {
    async play(urls, done, fail) {
      token += 1;
      onDone = done;
      onFail = fail;
      engine.setQueue(urls.map((src, i) => ({ id: `half-${token}-${i}`, src })));
      try {
        await engine.play();
      } catch (err) {
        const f = onFail;
        onDone = onFail = null;
        f?.(err);
      }
    },
    stop() {
      token += 1;
      onDone = onFail = null;
      engine.pause();
    },
    position(half) {
      return engine.currentIndex * half + engine.currentTime;
    },
  };
}
