// The host's functions, as one fixed list. A plug-in keeps host functions as table slots in its memory, and each
// instance has its own table, so every instance over one memory must install this list first and in this order:
// slot N is then the same function on every thread, each thread with its own behaviour behind it.
import {
    CLAP_CORE_EVENT_SPACE_ID,
    CLAP_EVENT_MIDI,
    CLAP_EVENT_NOTE_OFF,
    CLAP_EVENT_NOTE_ON,
    CLAP_EVENT_PARAM_GESTURE_BEGIN,
    CLAP_EVENT_PARAM_GESTURE_END,
    CLAP_EVENT_PARAM_VALUE,
    CLAP_EXT_AUDIO_PORTS,
    CLAP_EXT_GUI,
    CLAP_EXT_LATENCY,
    CLAP_EXT_LOG,
    CLAP_EXT_NOTE_NAME,
    CLAP_EXT_NOTE_PORTS,
    CLAP_EXT_PARAMS,
    CLAP_EXT_STATE,
    CLAP_EXT_THREAD_CHECK,
    CLAP_EXT_WEBVIEW,
    CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
    CLAP_VERSION_MAJOR,
    CLAP_VERSION_MINOR,
    CLAP_VERSION_REVISION,
    clap_event_note,
    clap_event_note_expression,
    clap_event_param_value,
    clap_host,
    clap_host_audio_ports,
    clap_host_gui,
    clap_host_latency,
    clap_host_log,
    clap_host_note_name,
    clap_host_note_ports,
    clap_host_params,
    clap_host_state,
    clap_host_thread_check,
    clap_host_webview,
    clap_input_events,
    clap_output_events,
} from "./clap.generated.ts";
import type { Event } from "./plugin-types.ts";
import type { Instance } from "./wasm-instance.ts";
import { asPtr, type Layout, type Ptr, type Wasm, type Word } from "./wasm-struct.ts";

export type Request =
    | "restart"
    | "process"
    | "callback"
    | "params-flush"
    | "params-rescan"
    | "state-dirty"
    | "latency"
    | "note-names";
export type GuiRequest = "resize" | "show" | "hide" | "closed" | "hints";

export const MAX_EVENTS = 256;
export const EVENT_SIZE = Math.max(clap_event_note.size, clap_event_param_value.size, clap_event_note_expression.size);

// The input events of the block being processed: written by whoever calls process, read by the plug-in.
export interface EventList {
    at: number;
    count: number;
}

// Notes the plug-in sends out while processing, decoded into reused objects for the next plug-in in a chain.
export class OutputList {
    readonly events: Event[];
    count = 0;
    constructor(capacity = MAX_EVENTS) {
        this.events = Array.from(
            { length: capacity },
            () => ({ at: 0, type: "note-on", key: 0, velocity: 0, channel: 0, id: 0, value: 0 }) as Event,
        );
    }
    pushGesture(at: number, id: number, begin: boolean): boolean {
        const e = this.events[this.count] as { at: number; type: string; id: number };
        if (!e) return false;
        e.at = at;
        e.type = begin ? "gesture-begin" : "gesture-end";
        e.id = id;
        this.count++;
        return true;
    }

    pushParam(at: number, id: number, value: number): boolean {
        const e = this.events[this.count] as { at: number; type: string; id: number; value: number };
        if (!e) return false;
        e.at = at;
        e.type = "param";
        e.id = id;
        e.value = value;
        this.count++;
        return true;
    }
    push(at: number, type: "note-on" | "note-off", key: number, velocity: number, channel: number): boolean {
        const e = this.events[this.count] as {
            at: number;
            type: string;
            key: number;
            velocity: number;
            channel: number;
        };
        if (!e) return false;
        e.at = at;
        e.type = type;
        e.key = key;
        e.velocity = velocity;
        e.channel = channel;
        this.count++;
        return true;
    }
}

export interface Behaviour {
    events: EventList;
    output: OutputList;
    extensions: Map<string, number>;
    request(request: Request): void;
    log(severity: number, message: string): void;
    isAudioThread(): boolean;
    isMainThread(): boolean;
    // The plug-in's interface sent a message to its page, or asked for something of its window.
    webviewSend(bytes: Uint8Array): boolean;
    gui(request: GuiRequest, width?: number, height?: number): boolean;
}

// Kept in step with package.json.
export const HOST_VERSION = "0.1.0";

const SLOTS = [
    [clap_host, "get_extension"],
    [clap_host, "request_restart"],
    [clap_host, "request_process"],
    [clap_host, "request_callback"],
    [clap_host_log, "log"],
    [clap_host_thread_check, "is_main_thread"],
    [clap_host_thread_check, "is_audio_thread"],
    [clap_host_params, "rescan"],
    [clap_host_params, "clear"],
    [clap_host_params, "request_flush"],
    [clap_host_state, "mark_dirty"],
    [clap_host_audio_ports, "is_rescan_flag_supported"],
    [clap_host_audio_ports, "rescan"],
    [clap_host_note_ports, "supported_dialects"],
    [clap_host_note_ports, "rescan"],
    [clap_host_gui, "resize_hints_changed"],
    [clap_host_gui, "request_resize"],
    [clap_host_gui, "request_show"],
    [clap_host_gui, "request_hide"],
    [clap_host_gui, "closed"],
    [clap_host_webview, "send"],
    [clap_host_latency, "changed"],
    [clap_host_note_name, "changed"],
    [clap_input_events, "size"],
    [clap_input_events, "get"],
    [clap_output_events, "try_push"],
] as const;

// A note leaving the plug-in, as a CLAP note event or a MIDI note message; anything else is accepted and dropped.
function readOutput(wasm: Wasm, at: number, out: OutputList): boolean {
    const v = wasm.view;
    if (v.getUint16(at + 8, true) !== CLAP_CORE_EVENT_SPACE_ID) return true;
    const type = v.getUint16(at + 10, true);
    const time = v.getUint32(at + 4, true);
    if (type === CLAP_EVENT_NOTE_ON || type === CLAP_EVENT_NOTE_OFF) {
        const on = type === CLAP_EVENT_NOTE_ON;
        return out.push(
            time,
            on ? "note-on" : "note-off",
            v.getInt16(at + 24, true),
            v.getFloat64(at + 32, true),
            v.getInt16(at + 22, true),
        );
    }
    if (type === CLAP_EVENT_PARAM_VALUE)
        return out.pushParam(time, v.getUint32(at + 16, true), v.getFloat64(at + 40, true));
    if (type === CLAP_EVENT_PARAM_GESTURE_BEGIN || type === CLAP_EVENT_PARAM_GESTURE_END)
        return out.pushGesture(time, v.getUint32(at + 16, true), type === CLAP_EVENT_PARAM_GESTURE_BEGIN);
    if (type === CLAP_EVENT_MIDI) {
        const status = v.getUint8(at + 18) & 0xf0;
        const key = v.getUint8(at + 19);
        const velocity = v.getUint8(at + 20);
        const channel = v.getUint8(at + 18) & 0x0f;
        if (status === 0x90 && velocity > 0) return out.push(time, "note-on", key, velocity / 127, channel);
        if (status === 0x80 || status === 0x90) return out.push(time, "note-off", key, velocity / 127, channel);
    }
    return true;
}

// Installs the list into this instance's table; returns the slots, in order.
export function installHost(wasm: Wasm, b: Behaviour): number[] {
    const fns: Record<string, (...args: never[]) => unknown> = {
        "clap_host.get_extension": (_host: number, name: Ptr<"char">) => b.extensions.get(wasm.string(name)) ?? 0,
        "clap_host.request_restart": () => b.request("restart"),
        "clap_host.request_process": () => b.request("process"),
        "clap_host.request_callback": () => b.request("callback"),
        "clap_host_log.log": (_host: number, severity: number, message: Ptr<"char">) =>
            b.log(severity, wasm.string(message)),
        "clap_host_thread_check.is_main_thread": () => b.isMainThread(),
        "clap_host_thread_check.is_audio_thread": () => b.isAudioThread(),
        "clap_host_params.rescan": () => b.request("params-rescan"),
        // Whatever was cleared, the page reads the parameters again.
        "clap_host_params.clear": () => b.request("params-rescan"),
        "clap_host_params.request_flush": () => b.request("params-flush"),
        "clap_host_state.mark_dirty": () => b.request("state-dirty"),
        // No flag is supported, so a plug-in changes its ports by asking for a restart, and a rescan is never valid.
        "clap_host_audio_ports.is_rescan_flag_supported": () => false,
        "clap_host_audio_ports.rescan": () => undefined,
        "clap_host_note_ports.supported_dialects": () => CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI,
        // Note ports carry no layout here; their names are what a page shows, through note names.
        "clap_host_note_ports.rescan": () => b.request("note-names"),
        "clap_host_latency.changed": () => b.request("latency"),
        "clap_host_note_name.changed": () => b.request("note-names"),
        "clap_host_gui.resize_hints_changed": () => void b.gui("hints"),
        "clap_host_gui.request_resize": (_host: number, width: number, height: number) =>
            b.gui("resize", width, height),
        "clap_host_gui.request_show": () => b.gui("show"),
        "clap_host_gui.request_hide": () => b.gui("hide"),
        "clap_host_gui.closed": () => void b.gui("closed"),
        "clap_host_webview.send": (_host: number, buffer: number, size: number) =>
            b.webviewSend(wasm.bytes.slice(buffer, buffer + size)),
        "clap_input_events.size": () => b.events.count,
        "clap_input_events.get": (_list: number, index: number) =>
            index < b.events.count ? b.events.at + index * EVENT_SIZE : 0,
        "clap_output_events.try_push": (_list: number, event: number) => readOutput(wasm, event, b.output),
    };
    return SLOTS.map(([layout, field]) => {
        const f = (layout as Layout).fields[field] as { params: readonly Word[]; result: Word | "void" };
        const fn = fns[`${layout.name}.${field}`];
        if (!fn) throw new Error(`no host function for ${layout.name}.${field}`);
        return wasm.addFn(f.params, f.result, fn);
    });
}

export interface HostStructs {
    host: Ptr<"clap_host">;
    inEvents: Ptr<"clap_input_events">;
    outEvents: Ptr<"clap_output_events">;
    extensions: Map<string, number>;
}

// The host's structs in the plug-in's memory, pointing at the installed slots. Built once, by the main side.
export function writeHost(instance: Instance, slots: number[]): HostStructs {
    const slot = (layout: Layout, field: string) => {
        const i = SLOTS.findIndex(([l, f]) => (l as Layout) === layout && f === field);
        const index = slots[i];
        if (index === undefined) throw new Error(`no slot for ${layout.name}.${field}`);
        return index;
    };
    const fill = <L extends Layout>(layout: L) => {
        const s = instance.allocStruct(layout);
        for (const [l, field] of SLOTS)
            if ((l as Layout) === layout)
                s.wasm.write("u32", s.at + (layout.fields[field]?.at ?? 0), slot(layout, field));
        return s;
    };

    const host = fill(clap_host);
    const version = host.inner("clap_version");
    version.set("major", CLAP_VERSION_MAJOR);
    version.set("minor", CLAP_VERSION_MINOR);
    version.set("revision", CLAP_VERSION_REVISION);
    host.set("name", instance.allocString("wclap-ts"));
    host.set("vendor", instance.allocString("wclap-ts"));
    host.set("url", instance.allocString("https://github.com/charCulbert/wclap-ts"));
    host.set("version", instance.allocString(HOST_VERSION));

    const extensions = new Map<string, number>([
        [CLAP_EXT_LOG, fill(clap_host_log).at],
        [CLAP_EXT_THREAD_CHECK, fill(clap_host_thread_check).at],
        [CLAP_EXT_PARAMS, fill(clap_host_params).at],
        [CLAP_EXT_STATE, fill(clap_host_state).at],
        [CLAP_EXT_AUDIO_PORTS, fill(clap_host_audio_ports).at],
        [CLAP_EXT_NOTE_PORTS, fill(clap_host_note_ports).at],
        [CLAP_EXT_GUI, fill(clap_host_gui).at],
        [CLAP_EXT_WEBVIEW, fill(clap_host_webview).at],
        [CLAP_EXT_LATENCY, fill(clap_host_latency).at],
        [CLAP_EXT_NOTE_NAME, fill(clap_host_note_name).at],
    ]);
    return {
        host: host.at,
        inEvents: asPtr(fill(clap_input_events).at),
        outEvents: asPtr(fill(clap_output_events).at),
        extensions,
    };
}
