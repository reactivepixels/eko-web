/**
 * The engine's audio graph:
 *
 *   source -> input -> [user inserts] -> fadeGain -> userGain -> [analyser] -> destination
 *
 * Inserts sit after normalization (which now lives on each source's own gain, ahead of
 * `input`) so a user EQ sees a consistent input level, and before the fader so it is not
 * fighting volume. The analyser sits last so it reflects what is actually heard.
 *
 * The chain is stable across a gapless promotion: sources connect into `input` and are
 * replaced freely, while everything downstream is untouched.
 */
import type { EkoInsert } from "../types";

const inputOf = (insert: EkoInsert): AudioNode => ("input" in insert ? insert.input : insert);
const outputOf = (insert: EkoInsert): AudioNode => ("output" in insert ? insert.output : insert);

export class EkoGraph {
  readonly context: AudioContext;
  /**
   * A stable passthrough at unity that every source connects into. It exists so that
   * `setInserts()` can rewire everything downstream without orphaning a playing source,
   * and so that per-source levels live on the sources rather than here.
   */
  readonly input: GainNode;
  /** Short ramps that keep play, pause and seek click-free. */
  readonly fadeGain: GainNode;
  /** The consumer's volume and mute. */
  readonly userGain: GainNode;

  private _analyser: AnalyserNode | null = null;
  private inserts: EkoInsert[] = [];

  constructor(context: AudioContext) {
    this.context = context;
    // Creation order is load-bearing: tests index ctx.gains by position.
    this.input = context.createGain();
    this.fadeGain = context.createGain();
    this.userGain = context.createGain();
    this.connectChain();
  }

  /**
   * Created on first access and spliced in, so a consumer that never draws a spectrum
   * pays nothing for one.
   */
  get analyser(): AnalyserNode {
    if (!this._analyser) {
      this._analyser = this.context.createAnalyser();
      this.connectChain();
    }
    return this._analyser;
  }

  /**
   * Replace the user insert chain (an EQ, a compressor, a convolver). Pass an empty array
   * to restore the direct connection. Inserts survive track changes. A composite
   * `{ input, output }` stage keeps its internal wiring: only `output` is disconnected.
   */
  setInserts(nodes: EkoInsert[]): void {
    for (const insert of this.inserts) outputOf(insert).disconnect();
    this.inserts = [...nodes];
    this.connectChain();
  }

  /** Tear down every connection this graph owns. Sources are not this module's concern. */
  destroy(): void {
    this.disconnectAll();
    this.inserts = [];
    this._analyser = null;
  }

  private disconnectAll(): void {
    this.input.disconnect();
    // Called from setInserts() too, after this.inserts has already been reassigned to the
    // new array. There it clears whatever leaves each new stage's output, which the engine
    // owns (see EkoInsert); a composite's inner wiring is never touched.
    for (const insert of this.inserts) outputOf(insert).disconnect();
    this.fadeGain.disconnect();
    this.userGain.disconnect();
    this._analyser?.disconnect();
  }

  /** Rebuild the whole downstream chain from scratch. Cheap, and impossible to get half-done. */
  private connectChain(): void {
    this.disconnectAll();

    let node: AudioNode = this.input;
    for (const insert of this.inserts) {
      node.connect(inputOf(insert));
      node = outputOf(insert);
    }
    node.connect(this.fadeGain);
    this.fadeGain.connect(this.userGain);

    if (this._analyser) {
      this.userGain.connect(this._analyser);
      this._analyser.connect(this.context.destination);
    } else {
      this.userGain.connect(this.context.destination);
    }
  }
}
