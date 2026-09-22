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

### React (`@rpxl/eko-web/react`)

```tsx
import { useEkoPlayer, useEkoTime } from "@rpxl/eko-web/react";

function Transport({ engine }) {
  const { paused, track, index, queueLength, play, pause, next } = useEkoPlayer(engine);
  return (
    <button onClick={paused ? play : pause}>
      {paused ? "Play" : "Pause"} {index + 1} / {queueLength}
    </button>
  );
}

function Progress({ engine }) {
  const { currentTime, duration } = useEkoTime(engine); // only this re-renders per frame
  return <progress value={currentTime} max={duration} />;
}
```

`useEkoPlayer` is `useSyncExternalStore` over the engine's snapshot, so it is
concurrent-safe and gives the right value during server rendering. `useEkoTime` is
separate on purpose: `currentTime` changes every frame, and keeping it out of the
snapshot means scrubbing re-renders your progress bar instead of your track list.

### Vue 3 (`@rpxl/eko-web/vue`)

```vue
<script setup>
import { useEkoPlayer, useEkoTime } from "@rpxl/eko-web/vue";

const player = useEkoPlayer(engine); // a readonly ref over the snapshot
const { currentTime, duration } = useEkoTime(engine);
</script>

<template>
  <button @click="player.paused ? player.play() : player.pause()">
    {{ player.paused ? "Play" : "Pause" }} {{ player.index + 1 }} / {{ player.queueLength }}
  </button>
  <progress :value="currentTime" :max="duration" />
</template>
```

Teardown goes through `onScopeDispose`, so it works inside a bare `effectScope` and not
only inside a component. The composables also accept a ref or a getter for the engine, so
swapping engines is reactive; the React hooks take the engine directly, since a new prop
re-renders anyway. Same concepts and same names on both sides, each in its own idiom, and
a test compares the two so they cannot drift apart.

Vue is in the first release rather than deferred for a reason: a second binding is the
only real proof the core is framework-free. One binding can hide accidental coupling.
Two cannot.

### Installing

Both frameworks are optional peer dependencies, so you install whichever you use and
neither ends up in the other's bundle. The library itself has no runtime dependencies.

### Loudness tags (`@rpxl/eko-web/replaygain`)

```ts
import { readReplayGain } from "@rpxl/eko-web/replaygain";

const { gainDb, peak } = await readReplayGain("/audio/track.flac");
engine.setQueue([{ id: "1", src: "/audio/track.flac", gainDb }]);
```

Reads ReplayGain tags out of a file's header: Vorbis comments (FLAC, Ogg Vorbis,
Ogg FLAC), ID3v2 and APEv2 (MP3), and both MP4 layouts (the iTunes freeform
atoms most taggers write, and the metadata-keys scheme ffmpeg writes). Gain and
peak only, nothing else.

It asks for the first 64KB with an HTTP Range request rather than pulling the
whole file, and only fetches the tail if the head had no tags, which is where
APEv2 and non-faststart MP4 keep theirs. A server that ignores Range just sends
everything and that works too.

A missing tag is never an error. A 404, a CORS rejection, a file that is not
audio: all of them resolve to an empty result, because this runs on the path to
playing a track and a thrown error there would turn a missing tag into a track
that will not play.

The engine does not import this. That is deliberate: it stays opt-in so a player
that does not want tag parsing does not ship the parsers. Reading the tag is
your call, and the engine takes the answer as `gainDb`.

### Where normalization gets its number

```ts
new EkoWebEngine({ normalize: "auto" }); // the default
```

- `"auto"` prefers a track's `gainDb`, and measures the decoded audio when there
  is none.
- `"tags"` uses `gainDb` only, and leaves a track alone when it has none.
- `"measure"` always measures and ignores `gainDb`.
- `false` applies no normalization.

`true` still means `"auto"`. Measuring needs the decoded samples, so on the
streaming path (long files played through an `<audio>` element) there is nothing
to measure: `"auto"` falls back to unity gain there and warns once, not once per
track.

### Lock screen and media keys (`@rpxl/eko-web/media-session`)

```ts
import { attachMediaSession } from "@rpxl/eko-web/media-session";

const detach = attachMediaSession(engine, {
  metadata: (track) => ({ title: track.id, artist: "...", artwork: [...] }),
});
```

Wires `navigator.mediaSession` to the engine: the transport actions, the
metadata, and the position state on a throttle rather than every frame.

The reason this is a module and not three lines in your app: a gapless boundary
changes track with no `src` swap and no element event, so hand-rolled wiring
never fires and the lock screen shows the wrong song for the rest of the queue.
This listens to the engine instead, so it stays right.

It feature-detects, so it is a harmless no-op in a browser without the API, and
it registers each action independently, because browsers support different
subsets and one unsupported action should not take the rest down with it.

### Drop into an existing `<audio>`-based player

eko-web ships an `HTMLMediaElement`-compatible facade (`@rpxl/eko-web/element`) so it slots into
players that drive an `<audio>` element (e.g. via a `mediaRef`) with no fork: you
immediately get loudness normalization. (True gapless needs the engine to own the queue;
see the docs.)

## Status

**v0.1, feature-complete engine, not yet published to npm.** Done: the engine (buffer
playback with true gapless queueing, crossfade, a streaming fallback for long files,
loudness normalization from a tag or measured, click-free play/pause/seek), the queue
(shuffle, repeat, history), the `replaygain` and `media-session` subpaths, React and Vue
bindings, coded errors
you can branch on, the `EkoAudioElement` facade (`@rpxl/eko-web/element`), and the
ear-test player in `examples/player/`. See
[`examples/README.md`](./examples/README.md); it needs a build first, it is not a no-build
page. 417 unit tests, dual ESM/CJS build with types.

Not yet: a WebCodecs source strategy.

The example player is the fastest way to hear the parts a test can't prove. Load a few
files, then try crossfade against gapless against gap on the same boundary, and shuffle
with the queue position readout visible.

## License

MIT. See [LICENSE](./LICENSE).

[webaudio]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
[eko]: https://github.com/reactivepixels/eko
