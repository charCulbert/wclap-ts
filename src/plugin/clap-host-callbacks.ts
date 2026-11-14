// The host's functions, as one fixed list. A plug-in keeps host functions as table slots in its memory, and each
// instance has its own table, so every instance over one memory must install this list first and in this order:
// slot N is then the same function on every thread, each thread with its own behaviour behind it.
import {
    CLAP_CORE_EVENT_SPACE_ID,
    CLAP_EVENT_MIDI,
    CLAP_EVENT_MIDI_SYSEX,
    CLAP_EVENT_MIDI2,
    CLAP_EVENT_NOTE_CHOKE,
    CLAP_EVENT_NOTE_END,
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
    CLAP_EXT_REMOTE_CONTROLS,
    CLAP_EXT_STATE,
    CLAP_EXT_TAIL,
    CLAP_EXT_THREAD_CHECK,
    CLAP_EXT_TIMER_SUPPORT,
    CLAP_EXT_VOICE_INFO,
    CLAP_EXT_WEBVIEW,
    CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
    CLAP_VERSION_MAJOR,
    CLAP_VERSION_MINOR,
    CLAP_VERSION_REVISION,
    clap_event_midi_sysex,
    clap_event_midi2,
    clap_event_note,
    clap_event_note_expression,
    clap_event_param_value,
    clap_event_transport,
    clap_host,
    clap_host_audio_ports,
    clap_host_gui,
    clap_host_latency,
    clap_host_log,
    clap_host_note_name,
    clap_host_note_ports,
    clap_host_params,
    clap_host_remote_controls,
    clap_host_state,
    clap_host_tail,
    clap_host_thread_check,
    clap_host_timer_support,
    clap_host_voice_info,
    clap_host_webview,
    clap_input_events,
    clap_output_events,
} from "./clap.generated.ts";
import type { Event, LogSeverity } from "./plugin-types.ts";
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
    | "note-names"
    | "remote-controls"
    | "voice-info";
export type GuiRequest = "resize" | "show" | "hide" | "closed" | "hints";

export const MAX_EVENTS = 256;
export const EVENT_SIZE = Math.max(
    clap_event_note.size,
    clap_event_param_value.size,
    clap_event_note_expression.size,
    clap_event_midi2.size,
    clap_event_midi_sysex.size,
    clap_event_transport.size,
);
// MIDI bytes (sysex) one block's events carry, at most: what the scheduler and each plug-in's output keep room for.
export const BLOCK_MIDI_BYTES = 4096;
// The longest MIDI message (a sysex) carried anywhere: the event queue refuses a longer one, and a plug-in's is
// dropped.
export const MAX_MIDI_BYTES = 1024;
// Room in a plug-in's memory for a block's MIDI bytes: the scheduler's and the previous plug-in's in a chain.
export const MIDI_AREA = 2 * BLOCK_MIDI_BYTES;

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
            () =>
                ({
                    at: 0,
                    type: "note-on",
                    key: 0,
                    velocity: 0,
                    channel: 0,
                    noteId: -1,
                    port: 0,
                    id: 0,
                    value: 0,
                    live: false,
                    data: this.#bytes,
                    offset: 0,
                    size: 0,
                }) as Event,
        );
    }

    readonly #bytes = new Uint8Array(BLOCK_MIDI_BYTES);
    #used = 0;
    // A few bytes for decoding one message.
    readonly scratch = new Uint8Array(3);

    // A MIDI message the plug-in sent, copied (its bytes live only for the call): `size` bytes from `from` in `source`.
    pushMidi(at: number, source: Uint8Array, from: number, size: number): boolean {
        if (this.count === 0) this.#used = 0;
        const e = this.events[this.count] as { at: number; type: string; offset: number; size: number };
        if (!e || this.#used + size > BLOCK_MIDI_BYTES) return false;
        const bytes = this.#bytes;
        for (let i = 0; i < size; i++) bytes[this.#used + i] = source[from + i] ?? 0;
        e.at = at;
        e.type = "midi";
        e.offset = this.#used;
        e.size = size;
        this.#used += size;
        this.count++;
        return true;
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
    // A note as the plug-in sent it, with its note ID (-1: none) and port.
    push(
        at: number,
        type: "note-on" | "note-off" | "note-choke" | "note-end",
        key: number,
        velocity: number,
        channel: number,
        noteId = -1,
        port = 0,
    ): boolean {
        const e = this.events[this.count] as {
            at: number;
            type: string;
            key: number;
            velocity: number;
            channel: number;
            noteId: number;
            port: number;
        };
        if (!e) return false;
        e.at = at;
        e.type = type;
        e.key = key;
        e.velocity = velocity;
        e.channel = channel;
        e.noteId = noteId;
        e.port = port;
        this.count++;
        return true;
    }
}

export interface Behaviour {
    events: EventList;
    output: OutputList;
    extensions: Map<string, number>;
    request(request: Request): void;
    log(message: string, severity: LogSeverity): void;
    isAudioThread(): boolean;
    isMainThread(): boolean;
    // The plug-in's interface sent a message to its page, or asked for something of its window.
    webviewSend(bytes: Uint8Array): boolean;
    gui(request: GuiRequest, width?: number, height?: number): boolean;
    // Timers, on the main side only: a new timer's ID, or -1 to refuse; whether there was such a timer.
    registerTimer?(periodMs: number): number;
    unregisterTimer?(id: number): boolean;
    // remote_controls.suggest_page, on the main side only.
    suggestPage?(pageId: number): void;
}

// By CLAP_LOG_DEBUG to CLAP_LOG_PLUGIN_MISBEHAVING: 0 to 6.
const SEVERITIES: LogSeverity[] = [
    "debug",
    "info",
    "warning",
    "error",
    "fatal",
    "host-misbehaving",
    "plugin-misbehaving",
];

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
    [clap_host_tail, "changed"],
    [clap_host_timer_support, "register_timer"],
    [clap_host_timer_support, "unregister_timer"],
    [clap_host_remote_controls, "changed"],
    [clap_host_remote_controls, "suggest_page"],
    [clap_host_voice_info, "changed"],
    [clap_input_events, "size"],
    [clap_input_events, "get"],
    [clap_output_events, "try_push"],
] as const;

// By CLAP_EVENT_NOTE_ON, _OFF, _CHOKE and _END: 0 to 3.
const NOTE_TYPES = ["note-on", "note-off", "note-choke", "note-end"] as const;

// Bytes in a MIDI 1 message by its status byte (sysex aside).
export function midiLength(status: number): number {
    if (status < 0xf0) return (status & 0xe0) === 0xc0 ? 2 : 3;
    return status === 0xf1 || status === 0xf3 ? 2 : status === 0xf2 ? 3 : 1;
}

// A MIDI 1 message from the plug-in: a note becomes a note event (as one in CLAP's dialect would be), anything else
// goes on as it is.
function readMidi(time: number, bytes: Uint8Array, at: number, length: number, out: OutputList): boolean {
    const status = bytes[at] ?? 0;
    const key = bytes[at + 1] ?? 0;
    const velocity = bytes[at + 2] ?? 0;
    const channel = status & 0x0f;
    const kind = status & 0xf0;
    if (kind === 0x90 && velocity > 0) return out.push(time, "note-on", key, velocity / 127, channel);
    if (kind === 0x80 || kind === 0x90) return out.push(time, "note-off", key, velocity / 127, channel);
    return out.pushMidi(time, bytes, at, length);
}

// What leaves the plug-in: notes (with the note IDs it gave), parameter changes and gestures, and MIDI; anything else
// is accepted and dropped. MIDI 2 is taken as MIDI 1 messages in a packet (UMP message type 2); other packets are
// dropped.
function readOutput(wasm: Wasm, at: number, out: OutputList): boolean {
    const v = wasm.view;
    if (v.getUint16(at + 8, true) !== CLAP_CORE_EVENT_SPACE_ID) return true;
    const type = v.getUint16(at + 10, true);
    const time = v.getUint32(at + 4, true);
    if (
        type === CLAP_EVENT_NOTE_ON ||
        type === CLAP_EVENT_NOTE_OFF ||
        type === CLAP_EVENT_NOTE_CHOKE ||
        type === CLAP_EVENT_NOTE_END
    )
        return out.push(
            time,
            NOTE_TYPES[type] ?? "note-off",
            v.getInt16(at + 24, true),
            v.getFloat64(at + 32, true),
            v.getInt16(at + 22, true),
            v.getInt32(at + 16, true),
            v.getInt16(at + 20, true),
        );
    if (type === CLAP_EVENT_PARAM_VALUE)
        return out.pushParam(time, v.getUint32(at + 16, true), v.getFloat64(at + 40, true));
    if (type === CLAP_EVENT_PARAM_GESTURE_BEGIN || type === CLAP_EVENT_PARAM_GESTURE_END)
        return out.pushGesture(time, v.getUint32(at + 16, true), type === CLAP_EVENT_PARAM_GESTURE_BEGIN);
    if (type === CLAP_EVENT_MIDI) return readMidi(time, wasm.bytes, at + 18, midiLength(v.getUint8(at + 18)), out);
    if (type === CLAP_EVENT_MIDI_SYSEX) {
        const size = v.getUint32(at + 24, true);
        return size <= MAX_MIDI_BYTES && out.pushMidi(time, wasm.bytes, v.getUint32(at + 20, true), size);
    }
    if (type === CLAP_EVENT_MIDI2) {
        const word = v.getUint32(at + 20, true);
        if (word >>> 28 !== 2) return true;
        // Type 4 bits, group 4 bits, then the MIDI 1 message's three bytes.
        const bytes = out.scratch;
        bytes[0] = (word >>> 16) & 0xff;
        bytes[1] = (word >>> 8) & 0x7f;
        bytes[2] = word & 0x7f;
        return readMidi(time, bytes, 0, midiLength(bytes[0] ?? 0), out);
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
            b.log(wasm.string(message), SEVERITIES[severity] ?? "info"),
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
        // The audio side reads the tail on every block the plug-in returns TAIL from.
        "clap_host_tail.changed": () => undefined,
        "clap_host_remote_controls.changed": () => b.request("remote-controls"),
        "clap_host_remote_controls.suggest_page": (_host: number, pageId: number) => b.suggestPage?.(pageId),
        "clap_host_voice_info.changed": () => b.request("voice-info"),
        "clap_host_timer_support.register_timer": (_host: number, periodMs: number, id: Ptr<"u32">) => {
            const timer = b.registerTimer?.(periodMs) ?? -1;
            if (timer < 0) return false;
            wasm.write("u32", id, timer);
            return true;
        },
        "clap_host_timer_support.unregister_timer": (_host: number, id: number) => b.unregisterTimer?.(id) ?? false,
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
        [CLAP_EXT_TAIL, fill(clap_host_tail).at],
        [CLAP_EXT_TIMER_SUPPORT, fill(clap_host_timer_support).at],
        [CLAP_EXT_REMOTE_CONTROLS, fill(clap_host_remote_controls).at],
        [CLAP_EXT_VOICE_INFO, fill(clap_host_voice_info).at],
    ]);
    return {
        host: host.at,
        inEvents: asPtr(fill(clap_input_events).at),
        outEvents: asPtr(fill(clap_output_events).at),
        extensions,
    };
}
