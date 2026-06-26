# eko-web

**EKO's web playback engine** — a small, framework-agnostic [Web Audio][webaudio] engine
that gives any web player **true gapless playback** and **loudness normalization
(ReplayGain/LUFS)** behind a clean, `<audio>`-compatible API.

It's the web-grade sibling of the native [EKO][eko] player. EKO on the desktop is
bit-perfect; **eko-web is not, and doesn't pretend to be** — see the scope below.

## What it does (and what it honestly can't)

✅ **What you get over a bare `<audio>` tag:**

- **True gapless** — albums, live sets, classical, DJ mixes flow with zero silence between
  tracks (sample-accurate scheduling, not a `setTimeout` hack).
- **Loudness normalization** — ReplayGain/LUFS so tracks don't jump in volume across a
  playlist. The single most audible "this sounds better" win on the web.
- **A real audio graph** — clean gain staging, ready for fades and EQ.

❌ **What it cannot do — and why:**

- **It is not bit-perfect and not "higher fidelity."** Every browser decodes the file,
  **resamples it to the output device's rate**, and mixes it through the OS. eko-web rides
  the same path — a single track sounds **identical** to a plain `<audio>` element. There is
  no exclusive-mode / hog-mode device access from a web page, so bit-perfect output is
  physically off the table. That's a browser/OS limit, not an effort one.

In short: **eko-web makes the _experience_ better (gapless + sane loudness), not the
_fidelity_.** If you need bit-perfect, that's what the native EKO app is for.

## Install

```bash
npm install eko-web   # or: pnpm add eko-web
```

## Quick start

```ts
import { EkoWebEngine } from "eko-web";

const engine = new EkoWebEngine({ normalize: true, gapless: true });

engine.on("timeupdate", ({ currentTime, duration }) => {
  /* update your UI */
});

engine.setQueue([
  { id: "1", src: "/audio/track1.flac" },
  { id: "2", src: "/audio/track2.flac" }, // plays gaplessly after track 1
]);
await engine.play(); // resumes the AudioContext on this user gesture
```

### Drop into an existing `<audio>`-based player

eko-web ships an `HTMLMediaElement`-compatible facade (`eko-web/element`, from Phase 4) so
it slots into players that drive an `<audio>` element (e.g. via a `mediaRef`) with no fork —
you immediately get loudness normalization. (True gapless needs the engine to own the
queue; see the docs.)

## Status

Early. Built in phases: scaffold → single-track + normalization → gapless + queue →
adapters + demo. Not yet published to npm.

## License

MIT — see [LICENSE](./LICENSE).

[webaudio]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
[eko]: https://github.com/reactivepixels/eko
