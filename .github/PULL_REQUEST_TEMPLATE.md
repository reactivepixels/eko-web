## What this changes

<!-- One or two sentences. What was wrong, or what is now possible. -->

## Why

<!-- The reasoning. If it fixes a bug, what caused it. -->

## How it was verified

<!--
Not "tests pass". What did you run, and how do you know the test would have caught the
problem? For a new test, say that you watched it fail first and what the failure said.
-->

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm format:check`

## If it touches the audio path

<!-- Delete this section if it does not. -->

- [ ] I listened to it, and said below what I heard
- [ ] Boundaries still sound right in gapless, crossfade and gap

<!--
The suite asserts scheduling maths and cannot hear a click. Anything near arming, fades,
disposal or the queue's next-track decision needs an ear as well as a green run.
-->
