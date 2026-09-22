# Contributing to EKO Web

Thanks for being here. EKO Web is a small library with a narrow job: make audio playback in
a browser sound right. The bar is high on purpose, and the things below are what keep it
there.

## The non-negotiables (read these first)

1. **The core stays framework-independent.** Nothing in `src/engine/`, `src/queue/` or
   `src/replaygain/` may import React, Vue, or any DOM framework. The bindings are thin
   wrappers in `src/react/` and `src/vue/`, and they are the only place a framework appears.
   If a binding needs a core change to work, that is a finding worth discussing, not a change
   to make quietly.
2. **Be honest about what the library does.** It is not bit-perfect and must never claim to
   be: browsers decode and resample to the output device's rate. The same applies to anything
   the UI reports. Show what is measurable, not what sounds good.
3. **The engine has no runtime dependencies.** React and Vue are optional peers. Adding a
   dependency to the core needs a strong argument.
4. **Boundaries are the product.** Gapless, crossfade and the transitions between tracks are
   the reason this exists. Changes near `armNext`, `clearArmed`, `handleSourceEnded` or the
   fade paths deserve extra care and extra tests.

## Quick start

```bash
git clone https://github.com/reactivepixels/eko-web.git && cd eko-web
pnpm install          # pnpm, not npm: npm fails on this repo's lockfile layout
pnpm test             # 422 tests, all in Node with hand-written Web Audio mocks
pnpm build
```

To see it running:

```bash
pnpm harness          # builds, then serves at http://localhost:4321
```

Then open `examples/vanilla/`, `examples/react/` or `examples/vue/`. All three are the same
player built three ways, so you can compare what each binding actually costs you.

## Tests, and the standard they are held to

Everything runs in Node against mocks in `tests/mock-audio.ts`. There is no jsdom except in
the two binding test files, which opt in per file.

**A test that has never failed has not been verified.** This project has repeatedly shipped
tests that passed whether or not the code under test was correct, and every one was caught by
the same technique: break the production line deliberately and check the test notices.

So when you add a test:

- Run it against the unfixed code first and watch it fail.
- Check it fails for the reason you predicted, not a typo or a missing import.
- Where a test asserts an empty result, know which check produced it. An assertion that
  expects `{}` can pass because the code bailed at an earlier, unrelated guard.

Watch for scenarios too simple to discriminate. Three real bugs here hid behind tests that
used one engine, one mount, or one track, where two would have exposed them.

## Before you open a pull request

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm format:check     # CI runs this too; a formatting miss is a red build
```

## Writing

No em dashes or en dashes anywhere: source, comments, docs, commit messages, UI strings. Use
a comma, a colon, parentheses, or two sentences. Plain hyphens in ranges and compound words
are fine.

Comments explain **why**, not what. The existing code is fairly good at this; match it. A
comment restating the line below it is noise, and a comment explaining a non-obvious
invariant is the most valuable thing in the file.

## What is deliberately out of scope

- **Metadata parsing beyond ReplayGain tags.** Title, artist and artwork are the consumer's.
- **UI.** The library gives you state and transport; what it looks like is your job.
- **Bit-perfect output.** Not possible from a web page. That is what the native
  [EKO](https://github.com/reactivepixels/eko) app is for.

## Reporting something

Bugs and ideas both go in [issues](https://github.com/reactivepixels/eko-web/issues). For
anything audible, say what you heard and on what: a click, a gap, a level jump, and the file
format and browser. "It clicks between tracks on Safari with 44.1 kHz FLACs" is worth ten
times "gapless is broken".
