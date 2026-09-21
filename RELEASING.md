# Releasing

This is a checklist, not automation. The split is deliberate: everything up to and including a
dry run can be done by anyone (or any agent) working on the repo. Everything that reaches the
public, the tag, the publish, and the registry listing, is the maintainer's.

## Before anything

- [ ] `main` is green: `npm run typecheck && npm run format:check && npx vitest run && npm run build`
- [ ] Working tree is clean and `main` is pushed.
- [ ] `git log --all --format=%B | grep -i claude` returns nothing.
- [ ] No em or en dashes in tracked files (the command matches them by codepoint, so this
      line does not trip its own check):
      `git ls-files -z | xargs -0 perl -ne 'print "$ARGV\n" and close ARGV if /[\x{2014}\x{2013}]/'`

## Ear test

Code review cannot verify the two headline claims. Do these before every release that touches
the engine, not just the first one.

- [ ] `npm run harness`, open `http://localhost:4321/examples/player/`.
- [ ] **Gapless.** Load the test tone. With gapless ticked the tone is unbroken; untick it and a
      tick appears at the seam. The tone is phase continuous by construction, so any click is the
      boundary and never the file.
- [ ] **Click-free transport.** Mid-tone, press pause, seek, and skip. Any click is a fade bug.
- [ ] **Loudness.** Load two real tracks mastered at different levels. They should sit at a
      similar perceived level without you touching the volume.
- [ ] **Streaming.** Set source to `element` and confirm it plays. Expect unity gain and a seam
      even with gapless ticked: streaming cannot be sample accurate and cannot measure loudness.

## Version

- [ ] Decide the bump. Pre-1.0, a breaking change to the public surface is still a minor.
- [ ] Update `version` in `package.json`.
- [ ] Update the README if any claim in it changed, including the test count.

## Dry run

- [ ] `npm run build`
- [ ] `npm pack --dry-run` and read the file list. Only `dist/` should ship. If anything else
      appears, fix `files` in `package.json` before going further.
- [ ] `npm publish --dry-run`

## Maintainer only

Everything below reaches other people and is not delegated.

- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`
- [ ] `npm publish`. The package is scoped, so `publishConfig.access` must be `public`, which it
      is; without it npm defaults scoped packages to restricted and the publish fails in a way
      that reads like an auth problem.
- [ ] Confirm the listing: `npm view @rpxl/eko-web version`
- [ ] If the repo is still private, decide whether this release makes it public.

## After

- [ ] Note anything that went wrong here, so the next release does not rediscover it.
