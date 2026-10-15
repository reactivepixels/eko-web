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

## Playground (`playground/`)

Players you remember, rebuilt on the real engine. `playground/index.html` is the gallery;
each player is a self-contained page beside it that imports `../../../dist/index.js` and
nothing else. Same setup as the player above:

```bash
npm run harness
# then open http://localhost:4321/examples/playground/
```

**EKO-AMP (`playground/winamp/`)** is a Winamp 2.x clone. The skin is painted in code into
sprite sheets laid out like Winamp's own skin bitmaps, and each window draws from them onto
a 1x canvas that is scaled up with whole pixels, so it stays crisp at any zoom. Drop audio
files anywhere (or press ADD), and the playlist plays gapless. The 10-band EQ, preamp and
balance are real Web Audio nodes in the engine's insert chain, and the spectrum and
oscilloscope read the engine's analyser. Press Play with nothing loaded and it queues a
generated loop three times, so the first thing you hear is three tracks joining with no
seam. Drag a titlebar to move a window; drag the main window to carry everything docked to
it. Z, X, C, V and B are prev, play, pause, stop and next, as they were.

**EKO hi-fi 1978 (`playground/hifi/`)** is a component stack: a D-55 cassette deck, a G-110
graphic EQ and an A-707 amplifier, drawn in HTML, CSS and SVG and scaled as one piece. The
tape is the engine's queue: drop files (or press EJECT) to load a cassette, and the spools,
counter and tape packs follow the position through the whole side. The EQ and amp are a
single composite insert (`setInserts([{ input, output }])`), so the panel can have parallel
paths: mono and balance matrix, speaker voicing, headphone crossfeed and a tape echo on
TAPE MON. Every control does something. DOLBY NR out lets you hear the tape (hiss, soft
saturation, wow and flutter, set by the tape type), INPUT switches to a record (crackle),
a radio between stations or a humming AUX lead, and REC records the amp's output to a
download on the J-card. The VU needles have real ballistics.

**GT-1 Gapless Blind Test (`playground/gapless/`)** puts the claim on the line. Each round is
one continuous piece of music cut at a single sample into two WAV files. Key A or B plays
them either with two plain `<audio>` tags (the second fully loaded and started on the first
one's `ended`, the best a page can do without Web Audio) or through the engine, in a random
order, with normalization off so level gives nothing away. An AudioWorklet records whichever
player is sounding, and after you guess, the screen shows what each one actually played: the
silence at the seam in milliseconds and samples, and a sample-level zoom of the join. Drop
two or more consecutive tracks from your own album and the rounds become your track changes.

**EKO Visuals (`playground/milkdrop/`)** is a MilkDrop-style visualizer in WebGL 2. Every
frame, the last frame is warped (zoom, rotation, swirl, ripple, a kaleidoscope) and faded in
half-float feedback buffers, and the new waveform and comets are drawn on top, so trails and
smoke build up on their own. Eight presets are per-frame equations of the engine's analyser
(bass, mid and treble relative to their own average, with smoothed versions and beat
detection); they rotate every 20 seconds or so and blend across 2.7 seconds. Press Play with
nothing loaded for a generated 64 second set in four tracks that only sounds continuous if
playback is gapless. Space changes preset, H cuts, L locks, and Z, X, C, V, B are the
transport.

**EKO Classic (`playground/ipod/`)** is a click-wheel player. Drag around the wheel to scroll
the menus (Artists, Albums, Songs, Shuffle Songs, Settings), press the centre to choose, and on
Now Playing the same wheel sets the volume, or scrubs after a press of the centre. Artist,
album and title are read from file names (and the folder, when you pick one), each album gets
a generated sleeve, and choosing a song hands the list it came from to the engine as a gapless
queue. Out of the box it syncs the generated Ember Set; press Sync or drop files to replace it,
and slide the hold switch on the top edge to lock it.

**EKO Mini Player (`playground/xp/`)** is a Luna-blue mini player on a rolling-hills desktop,
with a taskbar, a live clock, a start menu and tray balloons that pop up as each track begins.
The window drags by its title bar, minimizes into its taskbar button, and plays gapless
through the engine with loudness normalization on. It uses the library's `media-session`
binding, so the keyboard's media keys control it and the lock screen shows the track. Drop
files anywhere or open My Music; press Play with nothing loaded for the Ember Set.

In all of them, the pure parts (layout maths, the audio chains, meters, file handling) have unit
tests next to them as `*.test.js`, which `pnpm test` picks up.

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
