import { describe, it, expect } from "vitest";
import { EkoGraph } from "../src/engine/graph";
import { MockAudioContext, MockGainNode } from "./mock-audio";

function setup() {
  const ctx = new MockAudioContext();
  const graph = new EkoGraph(ctx as unknown as AudioContext);
  return { ctx, graph };
}

/** The mock records raw objects; read them back as mocks. */
const asMock = (node: unknown): MockGainNode => node as unknown as MockGainNode;

describe("EkoGraph", () => {
  it("creates gains in the order rgGain, fadeGain, userGain", () => {
    const { ctx, graph } = setup();
    expect(ctx.gains.length).toBe(3);
    expect(ctx.gains[0]).toBe(graph.rgGain as unknown as MockGainNode);
    expect(ctx.gains[1]).toBe(graph.fadeGain as unknown as MockGainNode);
    expect(ctx.gains[2]).toBe(graph.userGain as unknown as MockGainNode);
  });

  it("wires rgGain to fadeGain to userGain to destination by default", () => {
    const { ctx, graph } = setup();
    expect(asMock(graph.rgGain).connections).toEqual([graph.fadeGain]);
    expect(asMock(graph.fadeGain).connections).toEqual([graph.userGain]);
    expect(asMock(graph.userGain).connections).toEqual([ctx.destination]);
  });

  it("exposes rgGain as the input sources connect into", () => {
    const { graph } = setup();
    expect(graph.input).toBe(graph.rgGain);
  });

  it("does not create an analyser until one is asked for", () => {
    const { ctx, graph } = setup();
    expect(ctx.analysers.length).toBe(0);
    const analyser = graph.analyser;
    expect(ctx.analysers.length).toBe(1);
    // Repeated access reuses the same node.
    expect(graph.analyser).toBe(analyser);
    expect(ctx.analysers.length).toBe(1);
  });

  it("splices the analyser between userGain and destination", () => {
    const { ctx, graph } = setup();
    const analyser = graph.analyser;
    expect(asMock(graph.userGain).connections).toEqual([analyser]);
    expect(asMock(analyser).connections).toEqual([ctx.destination]);
  });

  it("splices user inserts between rgGain and fadeGain, in order", () => {
    const { graph } = setup();
    const a = new MockGainNode();
    const b = new MockGainNode();
    graph.setInserts([a as unknown as AudioNode, b as unknown as AudioNode]);

    expect(asMock(graph.rgGain).connections).toEqual([a]);
    expect(a.connections).toEqual([b]);
    expect(b.connections).toEqual([graph.fadeGain]);
    expect(asMock(graph.fadeGain).connections).toEqual([graph.userGain]);
  });

  it("restores the direct connection when inserts are cleared", () => {
    const { graph } = setup();
    const a = new MockGainNode();
    graph.setInserts([a as unknown as AudioNode]);
    graph.setInserts([]);

    expect(asMock(graph.rgGain).connections).toEqual([graph.fadeGain]);
    expect(a.connections).toEqual([]);
  });

  it("keeps the analyser spliced when inserts change", () => {
    const { ctx, graph } = setup();
    const analyser = graph.analyser;
    graph.setInserts([new MockGainNode() as unknown as AudioNode]);
    expect(asMock(graph.userGain).connections).toEqual([analyser]);
    expect(asMock(analyser).connections).toEqual([ctx.destination]);
  });

  it("keeps a connected source wired to rgGain across a setInserts rebuild", () => {
    const { graph } = setup();
    const source = new MockGainNode();
    source.connect(graph.input);

    graph.setInserts([new MockGainNode() as unknown as AudioNode]);

    expect(source.connections).toEqual([graph.rgGain]);
  });

  it("keeps a connected source wired to rgGain across the first analyser access", () => {
    const { graph } = setup();
    const source = new MockGainNode();
    source.connect(graph.input);

    void graph.analyser;

    expect(source.connections).toEqual([graph.rgGain]);
  });
});
