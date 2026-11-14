// The main-thread calls a page can make on a plug-in. One function serves both places they run: the Worker (two
// threads) and the AudioWorklet between blocks (one thread).

import type { PluginMain } from "../plugin/plugin-main-thread.ts";
import type { Change, Indication, LogSeverity, Preset, StateContext } from "../plugin/plugin-types.ts";
import type { ThreadStart } from "./plugin-spawned-threads.ts";

// Each call, by name, and what it returns: the page's results are typed from the plug-in's own methods.
const handlers = {
    "save-state": (p: PluginMain, c: { context?: StateContext | undefined }) => p.saveState(c.context),
    "load-state": (p: PluginMain, c: { bytes: Uint8Array; context?: StateContext | undefined }) =>
        p.loadState(c.bytes, c.context),
    presets: (p: PluginMain) => p.presets(),
    "load-preset": (p: PluginMain, c: { preset: Preset }) => p.loadPreset(c.preset),
    "open-interface": (p: PluginMain) => p.openInterface(),
    "close-interface": (p: PluginMain) => p.closeInterface(),
    "interface-message": (p: PluginMain, c: { bytes: Uint8Array }) => p.sendToInterface(c.bytes),
    "value-text": (p: PluginMain, c: { id: number; value: number }) => p.valueText(c.id, c.value),
    latency: (p: PluginMain) => p.latency(),
    tail: (p: PluginMain) => p.tail(),
    params: (p: PluginMain) => p.params(),
    "remote-controls": (p: PluginMain) => p.remoteControls(),
    indicate: (p: PluginMain, c: { id: number } & Indication) => p.indicate(c.id, c),
    // Here only while the audio side isn't processing: the Worker and the worklet host stop it around this call.
    "set-port-active": (p: PluginMain, c: { input: boolean; index: number; active: boolean }) =>
        p.setPortActive(c.input, c.index, c.active),
    "note-names": (p: PluginMain) => p.noteNames(),
    "voice-info": (p: PluginMain) => p.voiceInfo(),
    "param-values": (p: PluginMain) => p.paramValues(),
    "get-resource": (p: PluginMain, c: { path: string }) => p.getResource(c.path),
    "resize-interface": (p: PluginMain, c: { width: number; height: number }) => p.resizeInterface(c.width, c.height),
};

type Handlers = typeof handlers;
export type CallName = keyof Handlers;
type ArgsOf<K extends CallName> = Parameters<Handlers[K]> extends [PluginMain, infer A] ? A : unknown;
export type MainCall = { [K in CallName]: { call: K } & ArgsOf<K> }[CallName];
export type CallResult<K extends CallName> = ReturnType<Handlers[K]>;

export function mainCall(plugin: PluginMain, c: MainCall): unknown {
    return (handlers[c.call] as (p: PluginMain, c: MainCall) => unknown)(plugin, c);
}

// What a plug-in's main side tells the page, from whichever thread it runs on.
export type FromMain =
    | { type: "log"; id: number; text: string; severity: LogSeverity }
    | { type: "suggest-page"; id: number; pageId: number }
    | { type: "interface-message"; id: number; bytes: Uint8Array }
    | { type: "changed"; id: number; what: Change }
    // The plug-in started a thread: the page runs it in a Worker of its own (thread.js).
    | { type: "spawn"; id: number; start: ThreadStart }
    | {
          type: "interface-request";
          id: number;
          request: string;
          width?: number | undefined;
          height?: number | undefined;
      };
