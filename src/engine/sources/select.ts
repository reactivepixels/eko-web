import { BufferSourceStrategy } from "./buffer-source";
import { ElementSourceStrategy } from "./element-source";
import type { EkoTrack } from "../../types";
import type { AudioSourceStrategy } from "./source";

export interface SelectOptions {
  source: "auto" | "buffer" | "element";
  bufferMaxBytes: number;
}

/**
 * Ask the server how big a file is, without downloading it.
 *
 * Returns null whenever the answer is not knowable (no header, a failed request, a server
 * that refuses HEAD). Callers treat null as "take the buffer path", because most tracks
 * are fine and a missing Content-Length is common on development servers.
 *
 * `blob:` and `data:` URLs never reach the network: the bytes are already in memory (a
 * File the consumer handed the browser, or an inline data URI), so there is no server to
 * ask and nothing to stream even if the file were huge. Browsers also flatly refuse a HEAD
 * request against a `blob:` URL, so without this check every such track would cost a
 * doomed request and a network error the consumer neither caused nor can suppress. Skipped
 * before the `try`, not left to the catch below, so this never touches `fetch` at all.
 */
export async function probeContentLength(src: string): Promise<number | null> {
  if (src.startsWith("blob:") || src.startsWith("data:")) return null;
  try {
    const res = await fetch(src, { method: "HEAD" });
    if (!res.ok) return null;
    const header = res.headers.get("content-length");
    if (!header) return null;
    const bytes = Number(header);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Per-track override beats the engine option, which beats the size heuristic. */
export async function selectStrategy(
  track: EkoTrack,
  options: SelectOptions,
): Promise<AudioSourceStrategy> {
  const preference = track.source ?? options.source;
  if (preference === "buffer") return new BufferSourceStrategy();
  if (preference === "element") return new ElementSourceStrategy();

  const bytes = await probeContentLength(track.src);
  if (bytes !== null && bytes > options.bufferMaxBytes) return new ElementSourceStrategy();
  return new BufferSourceStrategy();
}
