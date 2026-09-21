# eko-web examples

## Player (`player/`), the canonical demo

Start here. This is the ear-test harness during development, and the page that becomes the
marketing player at release. Both files in this directory need a build first (there is no
no-build option: both import from `dist/`). Build the library, serve the repo root, and
open `examples/player/`:

```bash
npm run harness
# then open http://localhost:4321/examples/player/
```

**Serve the repo root, not this directory.** The page imports `../../dist/index.js`, which
sits above `examples/player/`. Point a server at `examples/player/` and that path lands
outside the server root, the module never loads, and nothing on the page responds: the file
picker does nothing and Play stays disabled. The page detects this and says so, but
`npm run harness` avoids it entirely. Opening the file directly over `file://` fails the
same way, because browsers block ES module imports there.

Pick a short loop or multiple tracks, press play, and listen at the seams where tracks
meet. Use **transition** to switch between gapless (no silence), crossfade (overlapped),
and gap (silent break). With a single file the engine queues it twice to test looping.
The **shuffle** checkbox randomizes the playback order without repeating a track until
all have played once. The **repeat** select lets you loop one track or the entire queue.
The **crossfade seconds** control appears only when crossfade is selected, and adjusts
the overlap duration. The **queue position** readout shows the current track index so you
can watch shuffle reordering happen. The **shelf** checkbox proves the user insert point
by putting a real biquad into the chain, and the spectrum is drawn from the engine's
analyser tap.

## Vanilla demo (`index.html`), superseded by `player/`

An older, minimal page for ear-testing gapless and normalization with your own files. Kept
for now, but `player/` above is the one to use and the one that gets kept current; treat
this one as legacy.

```bash
pnpm build            # produces dist/ that the demo imports
pnpm dlx serve .      # or: python3 -m http.server
# open http://localhost:3000/examples/  (port depends on the server)
```

Pick two tracks meant to flow (album pair, live segue), hit **Play**, and listen at the
A to B boundary: no silence. Toggle **normalize** to hear loudness matching across the two
masters.

## Using it from a `<audio>`-based player (e.g. gyro-media-player)

The `EkoAudioElement` facade quacks like an `HTMLAudioElement`, so it slots into a player
that drives a `mediaRef`, giving you single-track playback + loudness normalization with no fork:

```tsx
import { useMediaPlayer } from "gyro-media-player";
import { EkoAudioElement } from "@rpxl/eko-web/element";
import { useRef } from "react";

function Player({ src }: { src: string }) {
  const elRef = useRef(new EkoAudioElement({ normalize: true }));
  const player = useMediaPlayer(src, {
    mediaRef: { current: elRef.current as unknown as HTMLAudioElement },
  });
  return <button onClick={player.toggle}>{player.isPlaying ? "Pause" : "Play"}</button>;
}
```

For **true gapless**, drive the engine's queue directly (a host player's own playlist
`src`-swap reloads the element and defeats gapless):

```ts
elRef.current.engine.setQueue([
  { id: "1", src: "/a.flac" },
  { id: "2", src: "/b.flac" }, // starts the instant track 1 ends
]);
elRef.current.engine.on("trackchange", ({ index }) => setUiIndex(index));
```
