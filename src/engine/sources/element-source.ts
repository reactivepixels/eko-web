import { EkoError } from "../errors";
import { dbToLinear } from "../loudness";
import type { EkoTrack } from "../../types";
import type { AudioSourceStrategy, LoadedSource, LoadOptions } from "./source";

/**
 * How long to wait for `loadedmetadata` before giving up on a stalled connection.
 * Metadata needs only the file header, so this is generous rather than tight. A later
 * milestone can make it an option if anyone asks for one.
 */
export const METADATA_TIMEOUT_MS = 30_000;

/**
 * Stream a track through an HTMLAudioElement wired into the graph with
 * `createMediaElementSource`.
 *
 * Memory stays flat at any length, which is what makes hour-long files survivable. The
 * cost is that a media element cannot be scheduled to a sample, so this path is never
 * gapless, and there is no decoded buffer to measure, so loudness has to come from a
 * track's `gainDb`. Without one, it runs at unity.
 */
export class ElementSourceStrategy implements AudioSourceStrategy {
  readonly kind = "element" as const;
  readonly canGapless = false;

  /**
   * Per-instance, not per-process: a second player (or a fresh instance in an SPA that
   * does not reload the module) must still see the guidance to supply `gainDb`.
   */
  private warned = false;

  constructor(private readonly createElement: () => HTMLAudioElement = defaultCreateElement) {}

  async load(track: EkoTrack, ctx: AudioContext, options: LoadOptions): Promise<LoadedSource> {
    const element = this.createElement();
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    element.src = track.src;

    try {
      await waitForMetadata(element, track.src);
    } catch (err) {
      // A failed load must not leave the element pinned to a dead src, holding it in
      // memory until the caller happens to drop its reference. Release it with the same
      // discipline `ElementLoadedSource.dispose()` uses on the success path, then rethrow
      // the original error unchanged.
      element.pause();
      element.src = "";
      throw err;
    }

    const node = ctx.createMediaElementSource(element);
    return new ElementLoadedSource(track, element, node, this.elementNormGain(track, options));
  }

  private elementNormGain(track: EkoTrack, options: LoadOptions): number {
    if (!options.normalize) return 1;
    if (typeof track.gainDb === "number") return dbToLinear(track.gainDb);
    if (!this.warned) {
      this.warned = true;
      console.warn(
        "eko-web: streaming playback cannot measure loudness. Supply a track gainDb (for " +
          "example from a ReplayGain tag) to normalize long files.",
      );
    }
    return 1;
  }
}

function defaultCreateElement(): HTMLAudioElement {
  if (typeof Audio === "undefined") {
    throw new EkoError("no_web_audio", "eko-web: HTMLAudioElement is unavailable here");
  }
  return new Audio();
}

function waitForMetadata(element: HTMLAudioElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      clearTimeout(timer);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new EkoError("unsupported", `eko-web: the browser could not load ${src}`));
    };
    const onTimeout = (): void => {
      cleanup();
      reject(
        new EkoError(
          "fetch_failed",
          `eko-web: ${src} accepted the connection but never delivered metadata`,
        ),
      );
    };

    timer = setTimeout(onTimeout, METADATA_TIMEOUT_MS);
    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("error", onError);
  });
}

class ElementLoadedSource implements LoadedSource {
  readonly kind = "element" as const;
  readonly canGapless = false;

  private endedFn: (() => void) | null = null;
  private readonly onElementEnded = (): void => this.endedFn?.();
  private startErrorFn: ((error: unknown) => void) | null = null;
  private disposed = false;

  constructor(
    readonly track: EkoTrack,
    private readonly element: HTMLAudioElement,
    private readonly node: MediaElementAudioSourceNode,
    readonly normGain: number,
  ) {
    this.element.addEventListener("ended", this.onElementEnded);
  }

  get duration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  /**
   * The browser's own live buffered range, read straight off the element. Unlike the
   * buffer strategy, this genuinely grows over time as more of the stream downloads, and
   * can be less than `duration` for a long time on a slow connection.
   */
  get bufferedEnd(): number {
    const ranges = this.element.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return ranges.end(ranges.length - 1);
  }

  connect(destination: AudioNode): void {
    this.node.connect(destination);
  }

  /**
   * A media element cannot start on a given sample, so `when` is ignored. The engine must
   * never schedule a future start for a source with `canGapless: false`. May be called
   * more than once, since pause, play and seek all restart the same track.
   */
  start(_when: number, offset: number): void {
    if (this.disposed) {
      // Without this, a stale start() after dispose() would set currentTime and call
      // play() on an element whose src was already cleared, with nothing to explain why
      // playback silently never happens.
      throw new EkoError("destroyed", "eko-web: cannot start a source that has been disposed.");
    }
    this.element.currentTime = offset;
    // The browser can silently reject this without a user gesture (notably iOS Safari),
    // well after start() itself has already returned and the engine has already reported
    // "playing". Report that failure through onStartError() instead of swallowing it, so
    // the engine can correct the record instead of leaving silence with nothing to explain
    // it. A stale rejection arriving after this source has since been disposed (a pause,
    // seek or skip before the browser's promise settles) is a no-op: dispose() below
    // already clears `startErrorFn`, so there is nobody left to report to.
    this.element.play().catch((error: unknown) => {
      this.startErrorFn?.(error);
    });
  }

  stop(_when?: number): void {
    this.element.pause();
  }

  onEnded(fn: () => void): void {
    this.endedFn = fn;
  }

  onStartError(fn: (error: unknown) => void): void {
    this.startErrorFn = fn;
  }

  dispose(): void {
    this.disposed = true;
    this.element.removeEventListener("ended", this.onElementEnded);
    this.element.pause();
    this.element.src = "";
    this.node.disconnect();
    this.endedFn = null;
    this.startErrorFn = null;
  }
}
