// wclap-ts/worklet: for your own arrangement of plug-ins in one AudioWorklet (a graph with sends, buses, latency
// compensation). Import this in your worklet module, register your Topology, and load it with createHost.
// Runner does each plug-in's block; your render decides what feeds what.

export type { Scheduler } from "./events/event-queue.ts";
export { MAX_EVENTS, type OutputList } from "./plugin/clap-host-callbacks.ts";
export type { Event, Transport } from "./plugin/plugin-types.ts";
export { Chain, type ChainSetup, copyAudio } from "./worklet/chain.ts";
export { type Audio, type Processor, Runner, type Slot } from "./worklet/plugin-runner.ts";
export type { EventSource, HostContext, Topology } from "./worklet/topology.ts";
export { type MakeTopology, registerWclapProcessor } from "./worklet/worklet-host.ts";
