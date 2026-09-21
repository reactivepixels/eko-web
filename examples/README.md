# eko-web examples

## Player (`player/`), the canonical demo

Start here. This is the ear-test harness during development, and the page that becomes the
marketing player at release. Both files in this directory need a build first (there is no
no-build option: both import from `dist/`). Build the library, serve the repo root, and
open `examples/player/`:

```bash
npm run build
npx serve .
# then open http://localhost:3000/examples/player/
```

Pick a short loop, press play, and listen at the seam where it repeats. Untick **gapless**
and listen again: the silence you hear is what a plain `<audio>` element does at every
track boundary. The **shelf** checkbox proves the user insert point by putting a real
biquad into the chain, and the spectrum is drawn from the engine's analyser tap.

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
