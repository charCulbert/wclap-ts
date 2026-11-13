// wclap-ts/core: the parts the page API is built from, for a host with its own engine (a DAW's own AudioWorklet,
// its own threads). Plugin runs one plug-in on whichever thread calls it; Chain runs several per block; the event
// queue carries timed events between threads without allocating.

export { EventQueue, Scheduler, type Timed } from "./events/event-queue.ts";
export { Clock } from "./events/live-event-clock.ts";
export * as clap from "./plugin/clap.generated.ts";
export { PluginAudio } from "./plugin/plugin-audio-thread.ts";
export { PluginMain } from "./plugin/plugin-main-thread.ts";
export { Plugin } from "./plugin/plugin-one-thread.ts";
export type { Event } from "./plugin/plugin-types.ts";
export { canAttach, type Descriptor, Instance } from "./plugin/wasm-instance.ts";
export { asPtr, type Layout, NULL, type Ptr, Struct, Wasm } from "./plugin/wasm-struct.ts";
export { type Bundle, openBundle } from "./plugin/wclap-bundle.ts";
export { runThread, type Spawn, spawner, type ThreadStart } from "./threads/plugin-spawned-threads.ts";
export { AudioSide, MainThread, startMain } from "./threads/two-threads.ts";
export { Chain, copyAudio } from "./worklet/chain.ts";
export { type Audio, type Processor, Runner, type Slot } from "./worklet/plugin-runner.ts";
export type { Topology } from "./worklet/topology.ts";
