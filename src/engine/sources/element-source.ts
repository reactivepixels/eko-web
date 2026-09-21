import { EkoError } from "../errors";
import { dbToLinear } from "../loudness";
import type { EkoTrack } from "../../types";
import type { AudioSourceStrategy, LoadedSource, LoadOptions } from "./source";

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

  constructor(private readonly createElement: () => HTMLAudioElement = defaultCreateElement) {}

  async load(track: EkoTrack, ctx: AudioContext, options: LoadOptions): Promise<LoadedSource> {
    const element = this.createElement();
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    element.src = track.src;

    await waitForMetadata(element, track.src);
    const node = ctx.createMediaElementSource(element);
    return new ElementLoadedSource(track, element, node, elementNormGain(track, options));
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
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new EkoError("unsupported", `eko-web: the browser could not load ${src}`));
    };
    const cleanup = (): void => {
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
    };
    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("error", onError);
  });
}

let warnedAboutUnmeasurableLoudness = false;

function elementNormGain(track: EkoTrack, options: LoadOptions): number {
  if (!options.normalize) return 1;
  if (typeof track.gainDb === "number") return dbToLinear(track.gainDb);
  if (!warnedAboutUnmeasurableLoudness) {
    warnedAboutUnmeasurableLoudness = true;
    console.warn(
      "eko-web: streaming playback cannot measure loudness. Supply a track gainDb (for " +
        "example from a ReplayGain tag) to normalize long files.",
    );
  }
  return 1;
}

class ElementLoadedSource implements LoadedSource {
  readonly kind = "element" as const;
  readonly canGapless = false;

  private endedFn: (() => void) | null = null;
  private readonly onElementEnded = (): void => this.endedFn?.();

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

  connect(destination: AudioNode): void {
    this.node.connect(destination);
  }

  /**
   * A media element cannot start on a given sample, so `when` is ignored. The engine must
   * never schedule a future start for a source with `canGapless: false`.
   */
  start(_when: number, offset: number): void {
    this.element.currentTime = offset;
    void this.element.play();
  }

  stop(_when?: number): void {
    this.element.pause();
  }

  onEnded(fn: () => void): void {
    this.endedFn = fn;
  }

  dispose(): void {
    this.element.removeEventListener("ended", this.onElementEnded);
    this.element.pause();
    this.element.src = "";
    this.node.disconnect();
    this.endedFn = null;
  }
}
