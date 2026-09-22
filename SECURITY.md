# Security Policy

EKO Web is a client-side library. It has no server, no accounts and no telemetry, and it
makes no network requests of its own beyond fetching the audio URLs you hand it.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/reactivepixels/eko-web/security/advisories/new)
(the repo's Security tab, then "Report a vulnerability") and include:

- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- the version of `@rpxl/eko-web` and the browser you saw it in.

You will get an acknowledgement within a few days, and credit in the release notes unless
you would rather stay anonymous.

## Where to look

The interesting surface is the tag parsers, because they are the only part that reads
attacker-influenced bytes:

- **`src/replaygain/`** parses Vorbis comments, ID3v2, APEv2 and two MP4 layouts out of
  files fetched over the network. Every length, count and offset in there is meant to be
  bounds-checked against the buffer before use, and malformed input is meant to return an
  empty result rather than throw or read past the end.
- **`src/replaygain/fetch-range.ts`** issues Range requests to URLs the consumer supplies.

A crafted file that causes an over-read, a hang, or a throw that escapes into the caller is
a real finding and worth reporting. Past review fuzzed the parsers with tens of thousands of
random and mutated inputs without a hit, but that is evidence rather than proof.

## What is not a vulnerability

- **It is not bit-perfect.** Browsers decode and resample to the output device's rate. This
  is a documented limit, not a defect.
- **CORS failures when fetching audio.** That is the host's policy doing its job.
