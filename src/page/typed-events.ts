import type { Change } from "../plugin/plugin-types.ts";

// The events each class sends, so addEventListener types `detail`.
export interface PluginEvents {
    param: CustomEvent<{ id: number; value: number }>;
    // A value the page set took effect (at its scheduled time), or a state or preset load changed it.
    value: CustomEvent<{ id: number; value: number }>;
    gesture: CustomEvent<{ id: number; begin: boolean }>;
    change: CustomEvent<{ what: Change }>;
    // The plug-in suggests showing this remote-controls page (RemoteControlsPage.id).
    "suggest-page": CustomEvent<{ pageId: number }>;
}
export interface HostEvents {
    noteout: CustomEvent<NoteOut>;
    midiout: CustomEvent<MidiOut>;
    latencychange: Event;
    // What your arrangement posted (Topology.post).
    message: CustomEvent<unknown>;
}
type Listener<E> = ((event: E) => void) | { handleEvent(event: E): void };
type Options = boolean | AddEventListenerOptions;

// An EventTarget whose addEventListener knows each event's type.
export class TypedTarget<Events> extends EventTarget {
    override addEventListener<K extends keyof Events & string>(
        type: K,
        listener: Listener<Events[K]> | null,
        options?: Options,
    ): void;
    override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: Options,
    ): void;
    override addEventListener(type: string, listener: unknown, options?: Options): void {
        super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
    }
    override removeEventListener<K extends keyof Events & string>(
        type: K,
        listener: Listener<Events[K]> | null,
        options?: Options,
    ): void;
    override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: Options,
    ): void;
    override removeEventListener(type: string, listener: unknown, options?: Options): void {
        super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
    }
}

// A note leaving the chain; `time` is AudioContext time.
export interface NoteOut {
    on: boolean;
    key: number;
    velocity: number;
    channel: number;
    time: number;
}

// A MIDI message leaving the chain (notes included), one message's bytes; `time` is AudioContext time.
export interface MidiOut {
    data: Uint8Array;
    time: number;
}
