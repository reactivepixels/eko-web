# eko-web

**EKO's web playback engine**: a small, framework-agnostic [Web Audio][webaudio] engine
that gives any web player **true gapless playback** and **loudness normalization
(ReplayGain/LUFS)** behind a clean, `<audio>`-compatible API.

It's the web-grade sibling of the native [EKO][eko] player. EKO on the desktop is
bit-perfect; **eko-web is not, and doesn't pretend to be**. See the scope below.

## What it does (and what it honestly can't)

✅ **What you get over a bare `<audio>` tag:**

- **True gapless**: albums, live sets, classical, DJ mixes flow with zero silence between
  tracks (sample-accurate scheduling, not a `setTimeout` hack).
- **Crossfade, when you want it instead**: a boundary is one decision, not two features.
  Set `transition` to `"gapless"`, `"crossfade"` or `"gap"` and the engine schedules the
  rest. Both sides of a crossfade keep their own normalization gain while they overlap, so
  the blend doesn't undo the loudness work.
- **Loudness normalization**: ReplayGain/LUFS so tracks don't jump in volume across a
  playlist. The single most audible "this sounds better" win on the web. Uses a track's own
  precomputed gain tag when you have one, or measures it from the decoded audio when you
  don't.
- **Click-free transport**: play, pause and seek all ramp instead of cutting, with no API
  of their own. It just happens.
- **A queue that drives the prefetch**: shuffle, repeat one, repeat all, and a back button
  that walks what you actually played rather than the index below you. The queue has to
  live in the library because gapless arms the next track during the current one, so
  something has to answer "what plays next" before the boundary arrives.
- **A real audio graph**: clean gain staging, an insert point for your own EQ or effects
  (`setInserts`), and an analyser tap for a spectrum or waveform.
- **A streaming fallback for long files**: a DJ set or a podcast streams through an
  `<audio>` element instead of being decoded whole, so memory stays flat at any length. You
  lose sample-accurate gapless on that track's boundaries; everything else still applies.

❌ **What it cannot do, and why:**

- **It is not bit-perfect and not "higher fidelity."** Every browser decodes the file,
  **resamples it to the output device's rate**, and mixes it through the OS. eko-web rides
  the same path, so a single track sounds **identical** to a plain `<audio>` element. There is
  no exclusive-mode / hog-mode device access from a web page, so bit-perfect output is
  physically off the table. That's a browser/OS limit, not an effort one.

In short: **eko-web makes the _experience_ better (gapless + sane loudness), not the
_fidelity_.** If you need bit-perfect, that's what the native EKO app is for.

## Install

```bash
npm install @rpxl/eko-web   # or: pnpm add @rpxl/eko-web
```

## Quick start

```ts
import { EkoWebEngine } from "@rpxl/eko-web";

const engine = new EkoWebEngine({ normalize: true }); // gapless is the default transition

engine.on("timeupdate", ({ currentTime, duration }) => {
  /* update your UI */
});

engine.setQueue([
  { id: "1", src: "/audio/track1.flac" },
  { id: "2", src: "/audio/track2.flac" }, // plays gaplessly after track 1
]);
await engine.play(); // resumes the AudioContext on this user gesture
```

### Queue and transport

```ts
const engine = new EkoWebEngine({ transition: "crossfade", crossfadeSeconds: 3 });

engine.setQueue(tracks, 4); // start on the fifth track
engine.setShuffle(true);
engine.setRepeat("all"); // or "one" to loop the current track

engine.next();
engine.previous(); // steps back through what actually played, which matters under shuffle
engine.skipTo(9); // what a playlist row's click handler calls

engine.subscribe(() => {
  const { index, queueLength, track, lastTransition } = engine.getSnapshot();
});
```

`subscribe` plus `getSnapshot` is the `useSyncExternalStore` contract, so a React or Vue
binding is a few lines. The snapshot deliberately leaves out `currentTime`: it changes
every frame and would re-render your whole tree at 60fps. Read that from the engine.

### Drop into an existing `<audio>`-based player

eko-web ships an `HTMLMediaElement`-compatible facade (`@rpxl/eko-web/element`) so it slots into
players that drive an `<audio>` element (e.g. via a `mediaRef`) with no fork: you
immediately get loudness normalization. (True gapless needs the engine to own the queue;
see the docs.)

## Status

**v0.1, feature-complete engine, not yet published to npm.** Done: the engine (buffer
playback with true gapless queueing, crossfade, a streaming fallback for long files,
loudness normalization from a tag or measured, click-free play/pause/seek), the queue
(shuffle, repeat, history), coded errors you can branch on, the `EkoAudioElement` facade
(`@rpxl/eko-web/element`), and the ear-test player in `examples/player/`. See
[`examples/README.md`](./examples/README.md); it needs a build first, it is not a no-build
page. 223 unit tests, dual ESM/CJS build with types.

Not yet: React and Vue bindings, a `media-session` subpath for OS media keys, and a
WebCodecs source strategy.

The example player is the fastest way to hear the parts a test can't prove. Load a few
files, then try crossfade against gapless against gap on the same boundary, and shuffle
with the queue position readout visible.

## License

MIT. See [LICENSE](./LICENSE).

[webaudio]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
[eko]: https://github.com/reactivepixels/eko
