# The React and Vue demo players: shared spec

Two demos, one design. They must be visually indistinguishable, so the only thing
a reader is comparing is the framework code, not the styling. That is the whole
point of building both.

## What you are building

A working EKO Web player page, driven by the real library, styled with the
shared `examples/shared/eko-player.css`. The design is EKO's neumorphic
language, lifted from the existing hand-rolled player on the marketing site so
these match the product rather than inventing a new look.

`examples/shared/MARKUP-REFERENCE.html` is the exact DOM the stylesheet expects.
Reproduce that structure in your framework. Class names are the contract: if you
rename one, the styling silently breaks.

## Buildless, deliberately

No bundler, no JSX transform, no SFC compiler. Each demo is ONE `.html` file that
runs by opening it through the dev server. Rod opens these to look at them; a
build step between him and the pixels is friction that will stop them being used.

- React: import from `https://esm.sh/react@19` and `https://esm.sh/react-dom@19/client`,
  and build elements with `createElement`. Alias it (`const h = createElement`) so
  the tree stays readable.
- Vue: import from `https://esm.sh/vue@3/dist/vue.esm-browser.js` (the full build,
  which includes the runtime template compiler) and use a `template:` string.
- The library itself comes from `../../dist/react.js` and `../../dist/vue.js`,
  which is the real built output, NOT the source. Run `npm run build` first.

## The player's features

Everything here is driven by the library, not reimplemented:

- Now playing: cover placeholder, title, artist, from the current track
- A live spectrum, from `engine.analyser`
- The signal path strip: source kind, engine, output, and the seal
- Play/pause, previous, next, seek, volume
- Queue position, e.g. "2 / 5"
- A transition control: gapless, crossfade, gap
- A ReplayGain readout showing whether the gain came from a tag or measurement,
  using `readReplayGain` from `../../dist/replaygain.js`
- Light and dark, via the `data-theme` attribute the stylesheet already supports

## Use the bindings, that is the point

- React: `useEkoPlayer` and `useEkoTime` from `../../dist/react.js`
- Vue: the same two from `../../dist/vue.js`

Do NOT reach past the bindings to the engine for state the binding already gives
you. A reader should see the binding doing real work. `engine.analyser` and
`engine.setQueue` are fine to call directly; those are not state.

Note the split that exists for a reason: `useEkoTime` is separate because
`currentTime` changes every frame. Put the progress bar in its own component so
only that re-renders, and say so in a comment. That is the design being
demonstrated.

## Getting audio in

A file picker, plus a "use a test tone" button, same as `examples/player/`. Read
that file first: it already solves tone generation, object URLs and queueing, and
copying its approach keeps the three demos consistent.

## Quality bar

- It must actually work when opened. Verify in a browser, and say what you saw.
- No console errors.
- Responsive enough not to break at a narrow window.
- NO em or en dashes anywhere, including UI copy.
- NO AI, Claude or co-author attribution in commits or files.
