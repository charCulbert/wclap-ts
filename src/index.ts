// wclap-ts: WCLAPs on a web page. The building blocks underneath are in wclap-ts/core.

export { barAt, beatsToSeconds, type Loop, secondsToBeats, type TempoMap } from "./events/timeline.ts";
export { alignLatency } from "./page/align-latency.ts";
export { isolate } from "./page/isolate.ts";
export { loadWclap } from "./page/load-wclap.ts";
export { createTransport, Transport, type TransportOptions } from "./page/transport.ts";
export type { HostEvents, MidiOut, NoteOut, PluginEvents } from "./page/typed-events.ts";
export {
    type AddOptions,
    type ChainEvents,
    type ChainOptions,
    createChain,
    createHost,
    type Edit,
    type HostOptions,
    WclapChain,
    WclapHost,
} from "./page/wclap-host.ts";
export { WclapPlugin } from "./page/wclap-plugin.ts";
export type {
    Change,
    InterfaceInfo,
    LogSeverity,
    NoteName,
    ParamInfo,
    PortInfo,
    Ports,
    Preset,
    RemoteControlsPage,
    StateContext,
    VoiceInfo,
} from "./plugin/plugin-types.ts";
export type { Descriptor } from "./plugin/wasm-instance.ts";
export type { Stats } from "./worklet/worklet-host.ts";
