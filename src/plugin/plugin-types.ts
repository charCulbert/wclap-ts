import type { Control } from "../threads/control-block.ts";
import type { GuiRequest, Request } from "./clap-host-callbacks.ts";

export interface ParamInfo {
    id: number;
    name: string;
    module: string;
    min: number;
    max: number;
    default: number;
    flags: number;
}

// `target`: in a chain, the plug-in a scheduled event is for (-1: the start of the chain). `noteId`: CLAP's note ID,
// -1 (or left out) for none; a note-off or choke with none ends every voice on its key and channel. A choke stops
// voices at once, with no release. A modulation offsets a parameter without moving it, for every voice or (with
// `key` or `noteId`) one note's; an expression shapes one note (CLAP_NOTE_EXPRESSION_*: volume, pan, tuning,
// vibrato, expression, brightness, pressure). A MIDI event is one raw message (sysex included): its `size` bytes
// from `offset` in `data`, a buffer reused from block to block. `live`: from a player now (Web MIDI, or a call
// without a time), sent with CLAP_EVENT_IS_LIVE.
export type Event = (
    | {
          at: number;
          type: "note-on" | "note-off" | "note-choke";
          key: number;
          velocity: number;
          channel?: number;
          noteId?: number;
          target?: number;
      }
    // Only from a plug-in: a voice it started for a note-on has ended, with that note-on's ID, port, channel and key.
    | { at: number; type: "note-end"; key: number; channel: number; port: number; noteId: number; target?: number }
    | { at: number; type: "param"; id: number; value: number; target?: number }
    | {
          at: number;
          type: "param-mod";
          id: number;
          value: number;
          key?: number;
          channel?: number;
          noteId?: number;
          target?: number;
      }
    | {
          at: number;
          type: "expression";
          expression: number;
          key: number;
          value: number;
          channel?: number;
          noteId?: number;
          target?: number;
      }
    // A plug-in's interface began or ended moving a parameter (one undo step, for a host that keeps them).
    | { at: number; type: "gesture-begin" | "gesture-end"; id: number; target?: number }
    | { at: number; type: "midi"; data: Uint8Array; offset: number; size: number; target?: number }
) & { live?: boolean };

// Channel counts per port, and what each port is, so a graph can tell the main input from a sidechain.
export interface Ports {
    inputs: number[];
    outputs: number[];
    inputInfo?: PortInfo[];
    outputInfo?: PortInfo[];
}

export interface PortInfo {
    id: number;
    name: string;
    channels: number;
    // The port audio flows through by default; the others are sidechains or extra outputs.
    main: boolean;
    // "mono", "stereo", "surround", "ambisonic" or "" when unspecified.
    type: string;
    // The port on the other side that shares this one's buffer, or -1.
    inPlacePair: number;
}

// What the audio side needs, as plain numbers, so it can cross to another thread.
export interface AudioSetup {
    plugin: number;
    process: number;
    events: number;
    inputs: number[][];
    outputs: number[][];
    transport: number;
    maxFrames: number;
    slots: number[];
    extensions: [string, number][];
    // The plug-in's clap.params, for flush; 0 without one.
    params: number;
    // The plug-in's clap.tail, read while it's in its tail; 0 without one.
    tail: number;
    // Room in the plug-in's memory for each block's MIDI bytes (sysex), MIDI_AREA long.
    midi: number;
    // How its first note input takes notes: CLAP_NOTE_DIALECT_CLAP, _MIDI or _MIDI2; and every dialect it takes.
    dialect: number;
    dialects: number;
}

// Tempo and play state for plug-ins that follow the host (arpeggiators, synced delays).
export interface Transport {
    tempo: number;
    playing: boolean;
    // Position in quarter notes, advanced by whoever processes.
    beats: number;
    // Time signature, 4/4 when left out.
    numerator?: number;
    denominator?: number;
    // Position in seconds, advanced alongside beats; from beats at the current tempo when left out.
    seconds?: number;
    // The chain's own frame count, so every plug-in in it shares one steady time.
    frame?: number;
}

export interface MainOptions {
    log?: (text: string) => void;
    // Called for each request the plug-in makes from the main side (requests from the audio side reach the
    // audio side's own behaviour).
    onRequest?: (request: Request) => void;
    // The plug-in's interface sent its page a message, or asked to resize, show or hide its window.
    onInterfaceMessage?: (bytes: Uint8Array) => void;
    onInterfaceRequest?: (request: GuiRequest, width?: number, height?: number) => boolean;
    // Something the page shows changed: the latency (also after a restart), the parameter list, or note names.
    onChange?: (what: Change) => void;
    // Where threads the plug-in started leave their requests; idle collects them.
    control?: Control;
    // The host renders offline (an OfflineAudioContext): a plug-in with the render extension is told so before it's
    // activated.
    offline?: boolean;
}

export type Change = "latency" | "params" | "note-names" | "ports" | "state";

// A preset as the plug-in describes it; `kind` and `location` say where it lives (inside the plug-in, or a file).
export interface Preset {
    name: string;
    kind: number;
    location: string;
    loadKey: string;
}

// A page of up to 8 controls the plug-in suggests for hardware knobs or a compact panel.
export interface RemoteControlsPage {
    section: string;
    id: number;
    name: string;
    // Parameter ids, CLAP_INVALID_ID for an empty slot.
    params: number[];
    forPreset: boolean;
}

// A drum machine's "Kick" on key 36; -1 means any port, key or channel.
export interface NoteName {
    name: string;
    port: number;
    key: number;
    channel: number;
}

export interface InterfaceInfo {
    // Where the interface's page is: a path inside the bundle ("/page/index.html") or a full URL.
    uri: string;
    width: number;
    height: number;
    // Whether the host may size it (CLAP's gui.can_resize): then it's fitted with resizeInterface, not scaled.
    resizable: boolean;
}
