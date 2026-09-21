/**
 * The engine's audio graph:
 *
 *   source -> rgGain -> [user inserts] -> fadeGain -> userGain -> [analyser] -> destination
 *
 * Inserts sit after normalization so a user EQ sees a consistent input level, and before
 * the fader so it is not fighting volume. The analyser sits last so it reflects what is
 * actually heard.
 *
 * The chain is stable across a gapless promotion: sources connect into `input` and are
 * replaced freely, while everything downstream is untouched.
 */
export class EkoGraph {
  readonly context: AudioContext;
  /** Normalization gain. Jumps to the next track's value at a gapless boundary. */
  readonly rgGain: GainNode;
  /** Short ramps that keep play, pause and seek click-free. */
  readonly fadeGain: GainNode;
  /** The consumer's volume and mute. */
  readonly userGain: GainNode;

  private _analyser: AnalyserNode | null = null;
  private inserts: AudioNode[] = [];

  constructor(context: AudioContext) {
    this.context = context;
    // Creation order is load-bearing: tests index ctx.gains by position.
    this.rgGain = context.createGain();
    this.fadeGain = context.createGain();
    this.userGain = context.createGain();
    this.connectChain();
  }

  /** The node sources connect into. */
  get input(): AudioNode {
    return this.rgGain;
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
   * to restore the direct connection. Inserts survive track changes.
   */
  setInserts(nodes: AudioNode[]): void {
    for (const node of this.inserts) node.disconnect();
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
    this.rgGain.disconnect();
    // Called from setInserts() too, after this.inserts has already been reassigned to the
    // new array, so this pass is a no-op there: the new nodes have no outgoing connections
    // yet. It only does real work on the destroy() path, for the previous insert chain.
    for (const node of this.inserts) node.disconnect();
    this.fadeGain.disconnect();
    this.userGain.disconnect();
    this._analyser?.disconnect();
  }

  /** Rebuild the whole downstream chain from scratch. Cheap, and impossible to get half-done. */
  private connectChain(): void {
    this.disconnectAll();

    let node: AudioNode = this.rgGain;
    for (const insert of this.inserts) {
      node.connect(insert);
      node = insert;
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
