import { EkoWebEngine } from "../engine/eko-web-engine";
import type { EkoWebEngineOptions, EkoTrack } from "../types";

/** A DOM-ish event object, enough for media-player consumers (they read off `target`). */
interface FacadeEvent {
  type: string;
  target: EkoAudioElement;
}
type Listener = (event: FacadeEvent) => void;

/**
 * An `HTMLMediaElement`-compatible facade over {@link EkoWebEngine}, so eko-web drops into
 * players that drive an `<audio>` element (e.g. via a `mediaRef`) with **no fork**, so you
 * get loudness normalization immediately. Cast it to `HTMLAudioElement` at the boundary:
 *
 * ```ts
 * const el = new EkoAudioElement();
 * const player = useMediaPlayer(src, { mediaRef: { current: el as unknown as HTMLAudioElement } });
 * ```
 *
 * For TRUE gapless, drive the engine's queue directly via {@link setQueue} (a host
 * player's own playlist `src`-swap reloads the element and defeats gapless).
 */
export class EkoAudioElement {
  /** The underlying engine. Use `el.engine.setQueue(...)` for gapless. */
  readonly engine: EkoWebEngine;

  // Stored for surface compatibility; not all are acted on in v1.
  loop = false;
  preload: "none" | "metadata" | "auto" = "auto";
  crossOrigin: string | null = null;
  playbackRate = 1;
  autoplay = false;

  private listeners = new Map<string, Set<Listener>>();
  private _src = "";

  constructor(options?: EkoWebEngineOptions) {
    this.engine = new EkoWebEngine(options);
    this.wireEngineEvents();
  }

  // ── HTMLMediaElement-compatible properties ──────────────────────────────────
  get src(): string {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
    if (value) this.engine.load(value);
  }

  get currentTime(): number {
    return this.engine.currentTime;
  }
  set currentTime(t: number) {
    this.dispatch("seeking");
    this.engine.seek(t);
    this.dispatch("seeked");
    this.dispatch("timeupdate");
  }

  get duration(): number {
    return this.engine.duration;
  }
  get paused(): boolean {
    return this.engine.paused;
  }
  get ended(): boolean {
    return this.engine.state === "ended";
  }
  get volume(): number {
    return this.engine.volume;
  }
  set volume(v: number) {
    this.engine.setVolume(v);
  }
  get muted(): boolean {
    return this.engine.muted;
  }
  set muted(m: boolean) {
    this.engine.setMuted(m);
  }
  /**
   * HAVE_NOTHING (0) until loaded. Once loaded: HAVE_ENOUGH_DATA (4) for the buffer
   * strategy, since the whole file really is already decoded and playback cannot stall on
   * a slow connection from here. HAVE_CURRENT_DATA (2) for the element strategy, since
   * eko-web cannot promise more than "playable right now" there: the browser is still
   * streaming the rest, and a slow connection can still stall it.
   */
  get readyState(): number {
    const snap = this.engine.getSnapshot();
    if (snap.state === "idle" || snap.state === "loading") return 0;
    return snap.sourceKind === "element" ? 2 : 4;
  }
  /**
   * A `TimeRanges`-like view. For the buffer strategy the whole track is decoded, so this
   * is always `[0, duration]`. For the element strategy it reflects what the browser has
   * actually downloaded so far (`engine.bufferedEnd`), which grows over time and can sit
   * well short of `duration` on a slow connection. This is exactly what a host player's
   * buffer bar reads, so it has to be real, not a standing claim that everything is ready.
   */
  get buffered(): { length: number; start: (i: number) => number; end: (i: number) => number } {
    const end = this.engine.bufferedEnd;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  // ── HTMLMediaElement-compatible methods ─────────────────────────────────────
  play(): Promise<void> {
    return this.engine.play();
  }
  pause(): void {
    this.engine.pause();
  }
  /** Re-load the current `src` (mirrors `HTMLMediaElement.load()`). */
  load(): void {
    if (this._src) this.engine.load(this._src);
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  // ── Beyond the element surface ──────────────────────────────────────────────
  /** Drive a gapless queue directly (the reason to use eko-web over a bare element). */
  setQueue(tracks: EkoTrack[]): void {
    this.engine.setQueue(tracks);
  }

  destroy(): void {
    this.engine.destroy();
    this.listeners.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  private dispatch(type: string): void {
    const set = this.listeners.get(type);
    if (!set) return;
    const event: FacadeEvent = { type, target: this };
    for (const fn of [...set]) fn(event);
  }

  private wireEngineEvents(): void {
    this.engine.on("loadstart", () => this.dispatch("loadstart"));
    this.engine.on("loadedmetadata", () => this.dispatch("loadedmetadata"));
    this.engine.on("durationchange", () => this.dispatch("durationchange"));
    this.engine.on("canplay", () => {
      this.dispatch("canplay");
      this.dispatch("canplaythrough");
      if (this.autoplay) void this.engine.play();
    });
    this.engine.on("play", () => this.dispatch("play"));
    this.engine.on("pause", () => this.dispatch("pause"));
    this.engine.on("timeupdate", () => this.dispatch("timeupdate"));
    this.engine.on("ended", () => this.dispatch("ended"));
    this.engine.on("volumechange", () => this.dispatch("volumechange"));
    this.engine.on("error", () => this.dispatch("error"));
    // A gapless promotion looks like a new track loading to element consumers.
    this.engine.on("trackchange", () => {
      this.dispatch("loadedmetadata");
      this.dispatch("durationchange");
    });
  }
}
