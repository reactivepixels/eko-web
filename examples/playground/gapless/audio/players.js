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

function ready(el) {
  return new Promise((resolve, reject) => {
    if (el.readyState >= 4) return resolve();
    const ok = () => {
      el.removeEventListener("canplaythrough", ok);
      el.removeEventListener("error", bad);
      resolve();
    };
    const bad = () => {
      el.removeEventListener("canplaythrough", ok);
      el.removeEventListener("error", bad);
      reject(el.error || new Error("load"));
    };
    el.addEventListener("canplaythrough", ok);
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
  let onDone = null;

  function stop() {
    token += 1;
    for (const el of els) {
      el.onended = null;
      el.pause();
    }
    onDone = null;
  }

  return {
    async play(urls, done) {
      stop();
      const mine = token;
      onDone = done;
      els.forEach((el, i) => {
        el.src = urls[i];
        el.currentTime = 0;
      });
      await Promise.all(els.map(ready));
      if (mine !== token) return;
      els[0].onended = () => {
        if (mine === token) els[1].play();
      };
      els[1].onended = () => {
        if (mine === token) onDone?.();
      };
      await els[0].play();
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
  engine.on("ended", () => {
    const done = onDone;
    onDone = null;
    done?.();
  });
  return {
    async play(urls, done) {
      token += 1;
      onDone = done;
      engine.setQueue(urls.map((src, i) => ({ id: `half-${token}-${i}`, src })));
      await engine.play();
    },
    stop() {
      token += 1;
      onDone = null;
      engine.pause();
    },
    position(half) {
      return engine.currentIndex * half + engine.currentTime;
    },
  };
}
