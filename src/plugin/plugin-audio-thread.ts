// A plug-in's audio-thread role (CLAP's [audio-thread] calls): process, flush, reset, stop, writing each block's
// events and transport into the plug-in's memory.
import {
    CLAP_CORE_EVENT_SPACE_ID,
    CLAP_EVENT_NOTE_CHOKE,
    CLAP_EVENT_NOTE_EXPRESSION,
    CLAP_EVENT_NOTE_OFF,
    CLAP_EVENT_NOTE_ON,
    CLAP_EVENT_PARAM_GESTURE_BEGIN,
    CLAP_EVENT_PARAM_GESTURE_END,
    CLAP_EVENT_PARAM_MOD,
    CLAP_EVENT_PARAM_VALUE,
    CLAP_PROCESS_ERROR,
    CLAP_TRANSPORT_HAS_BEATS_TIMELINE,
    CLAP_TRANSPORT_HAS_SECONDS_TIMELINE,
    CLAP_TRANSPORT_HAS_TEMPO,
    CLAP_TRANSPORT_HAS_TIME_SIGNATURE,
    CLAP_TRANSPORT_IS_PLAYING,
    clap_event_header,
    clap_event_note,
    clap_event_note_expression,
    clap_event_param_gesture,
    clap_event_param_value,
    clap_event_transport,
    clap_plugin,
    clap_plugin_params,
    clap_plugin_tail,
    clap_process,
} from "./clap.generated.ts";
import { EVENT_SIZE, type EventList, MAX_EVENTS, type OutputList } from "./clap-host-callbacks.ts";
import type { AudioSetup, Event, Transport } from "./plugin-types.ts";
import { ProcessStatus } from "./process-status.ts";
import { asPtr, NULL, type Ptr, type Struct, type Wasm } from "./wasm-struct.ts";

// Takes a request the plug-in made of the audio side (from any of its threads): true if it was made since the last
// take.
export type TakeRequest = (request: "process" | "params-flush") => boolean;

export class PluginAudio {
    readonly wasm: Wasm;
    readonly setup: AudioSetup;
    readonly #events: EventList;
    readonly #thread: { audio: boolean };
    readonly #plugin: Struct<typeof clap_plugin>;
    readonly #process: Struct<typeof clap_process>;
    readonly #note: Struct<typeof clap_event_note>;
    readonly #param: Struct<typeof clap_event_param_value>;
    readonly #header: Struct<typeof clap_event_header>;
    readonly #expression: Struct<typeof clap_event_note_expression>;
    readonly #transport: Struct<typeof clap_event_transport>;
    readonly #params: Struct<typeof clap_plugin_params> | undefined;
    readonly #tail: Struct<typeof clap_plugin_tail> | undefined;
    readonly #take: TakeRequest;
    readonly #status = new ProcessStatus();
    readonly #readTail = () => this.#tail?.call("get", this.#plugin.at) ?? 0;
    // The notes the plug-in sent out in the last block.
    readonly output: OutputList;
    #processing = false;
    #steadyTime = 0;
    #skipped = false;

    // `events`, `output` and `thread` are what this thread's host functions read and write; `take` reads the
    // plug-in's request_process and params.request_flush.
    constructor(
        wasm: Wasm,
        setup: AudioSetup,
        events: EventList,
        output: OutputList,
        thread: { audio: boolean },
        take: TakeRequest = () => false,
    ) {
        this.wasm = wasm;
        this.setup = setup;
        this.#events = events;
        this.output = output;
        this.#thread = thread;
        this.#take = take;
        this.#transport = wasm.struct(clap_event_transport, asPtr(setup.transport));
        this.#plugin = wasm.struct(clap_plugin, asPtr(setup.plugin));
        this.#process = wasm.struct(clap_process, asPtr(setup.process));
        this.#note = wasm.struct(clap_event_note, NULL);
        this.#param = wasm.struct(clap_event_param_value, NULL);
        this.#header = wasm.struct(clap_event_header, NULL);
        this.#expression = wasm.struct(clap_event_note_expression, NULL);
        this.#params = setup.params ? wasm.struct(clap_plugin_params, asPtr(setup.params)) : undefined;
        this.#tail = setup.tail ? wasm.struct(clap_plugin_tail, asPtr(setup.tail)) : undefined;
        events.at = setup.events;
    }

    // For a plug-in that isn't being processed (bypassed): its parameter events in `events`, and the changes it
    // makes itself (its interface's knobs) back in `output`. CLAP's params.flush, which an active plug-in takes on
    // the audio thread, between process calls.
    // From the audio thread, while it isn't processing a block: clears delay lines and voices.
    reset(): void {
        this.#status.reset();
        this.#thread.audio = true;
        try {
            this.#plugin.call("reset", this.#plugin.at);
        } finally {
            this.#thread.audio = false;
        }
    }

    flush(events: readonly Event[], count: number): void {
        this.#take("params-flush");
        this.output.count = 0;
        if (!this.#params) return;
        let n = 0;
        for (let i = 0; i < count && n < MAX_EVENTS; i++) {
            const event = events[i];
            if (event?.type === "param" || event?.type === "param-mod") this.#writeEvent(event, n++);
        }
        this.#events.count = n;
        this.#thread.audio = true;
        try {
            this.#params.call(
                "flush",
                this.#plugin.at,
                this.#process.get("in_events"),
                this.#process.get("out_events"),
            );
        } finally {
            this.#thread.audio = false;
            this.#events.count = 0;
        }
    }

    get processing(): boolean {
        return this.#processing;
    }

    // Whether the last block was skipped because the plug-in sleeps (a diagnostic; its output was silence).
    get skipped(): boolean {
        return this.#skipped;
    }

    // Events in time order, at their frame in the block (the first `count`); inputs and outputs per port, per
    // channel. The outputs are views of the plug-in's memory, valid until the next call. Once the block size is
    // steady this allocates nothing. While the plug-in sleeps (its process status) the block is skipped: its outputs
    // are silent and steady_time still moves on.
    process(
        frames: number,
        events: readonly Event[] = [],
        inputs: readonly (readonly Float32Array[])[] = [],
        count = events.length,
        transport?: Transport,
    ): Float32Array[][] {
        const max = this.setup.maxFrames;
        if (frames > max) throw new Error(`${frames} frames is more than the ${max} activated`);
        if (count > MAX_EVENTS) throw new Error(`more than ${MAX_EVENTS} events in one block`);
        for (let i = 0; i < count; i++) {
            const event = events[i];
            if (!event) break;
            if (!(event.at >= 0 && event.at < frames)) throw new Error(`event at frame ${event.at}, outside the block`);
            if (i > 0 && event.at < (events[i - 1]?.at ?? 0)) throw new Error("events are not in time order");
            this.#writeEvent(event, i);
        }
        const views = this.#viewsFor(frames);
        for (let p = 0; p < views.inputs.length; p++) {
            const port = views.inputs[p] ?? [];
            for (let c = 0; c < port.length; c++) {
                const source = inputs[p]?.[c] ?? (inputs[p]?.length === 1 ? inputs[p]?.[0] : undefined);
                const target = port[c];
                if (!target) continue;
                if (source) {
                    target.set(source.length > frames ? source.subarray(0, frames) : source);
                    if (source.length < frames) target.fill(0, source.length);
                } else target.fill(0);
            }
        }

        const flush = this.#take("params-flush");
        const requested = this.#take("process");
        this.#skipped = this.#status.skip(count > 0 || requested, views.inputs, frames);
        if (this.#skipped) {
            this.#steadyTime += frames;
            for (const port of views.outputs) for (const channel of port) channel.fill(0);
            // A flush it asked for while asleep: params.flush, which leaves it asleep.
            if (flush) this.flush(events, 0);
            else this.output.count = 0;
            return this.#viewsFor(frames).outputs;
        }

        this.#process.set("steady_time", transport?.frame ?? this.#steadyTime);
        this.#process.set("frames_count", frames);
        this.#process.set("transport", transport ? this.#writeTransport(transport) : NULL);
        this.#events.count = count;
        this.output.count = 0;
        this.#thread.audio = true;
        let outputs: Float32Array[][];
        try {
            if (!this.#processing) {
                if (!this.#plugin.call("start_processing", this.#plugin.at)) throw new Error("start_processing failed");
                this.#processing = true;
            }
            const status = this.#plugin.call("process", this.#plugin.at, this.#process.at);
            // The plug-in may have grown its memory while processing.
            outputs = this.#viewsFor(frames).outputs;
            // CLAP: on an error, the output is discarded; the plug-in carries on.
            if (status === CLAP_PROCESS_ERROR) for (const port of outputs) for (const channel of port) channel.fill(0);
            this.#status.after(status, outputs, frames, this.#readTail);
        } finally {
            this.#thread.audio = false;
            this.#events.count = 0;
        }
        this.#steadyTime += frames;
        return outputs;
    }

    // Bars from the start of the timeline, in the transport's time signature (4/4 unless set).
    #writeTransport(t: Transport): Ptr<"clap_event_transport"> {
        const s = this.#transport;
        const numerator = t.numerator ?? 4;
        const denominator = t.denominator ?? 4;
        const beatsPerBar = (numerator * 4) / denominator;
        const bar = Math.floor(t.beats / beatsPerBar);
        s.set(
            "flags",
            CLAP_TRANSPORT_HAS_TEMPO |
                CLAP_TRANSPORT_HAS_BEATS_TIMELINE |
                CLAP_TRANSPORT_HAS_SECONDS_TIMELINE |
                CLAP_TRANSPORT_HAS_TIME_SIGNATURE |
                (t.playing ? CLAP_TRANSPORT_IS_PLAYING : 0),
        );
        s.set("song_pos_beats", Math.round(t.beats * 2 ** 31));
        s.set("song_pos_seconds", Math.round((t.seconds ?? (t.beats * 60) / t.tempo) * 2 ** 31));
        s.set("tempo", t.tempo);
        s.set("bar_number", bar);
        s.set("bar_start", Math.round(bar * beatsPerBar * 2 ** 31));
        s.set("tsig_num", numerator);
        s.set("tsig_denom", denominator);
        return s.at;
    }

    stop(): void {
        this.#status.reset();
        if (!this.#processing) return;
        this.#processing = false;
        this.#thread.audio = true;
        try {
            this.#plugin.call("stop_processing", this.#plugin.at);
        } finally {
            this.#thread.audio = false;
        }
    }

    #views = {
        buffer: undefined as ArrayBufferLike | undefined,
        frames: 0,
        inputs: [] as Float32Array[][],
        outputs: [] as Float32Array[][],
    };

    // Views of the audio buffers, remade only when the block size changes or the memory grows.
    #viewsFor(frames: number): { inputs: Float32Array[][]; outputs: Float32Array[][] } {
        const buffer = this.wasm.memory.buffer;
        if (this.#views.buffer !== buffer || this.#views.frames !== frames) {
            const view = (ports: number[][]) => ports.map((p) => p.map((at) => new Float32Array(buffer, at, frames)));
            this.#views = { buffer, frames, inputs: view(this.setup.inputs), outputs: view(this.setup.outputs) };
        }
        return this.#views;
    }

    #writeEvent(event: Event, index: number): void {
        const at = this.setup.events + index * EVENT_SIZE;
        if (event.type === "param" || event.type === "param-mod") {
            // A modulation has the same layout, with its amount where the value is.
            const e = this.#param.moveTo(asPtr(at));
            const noteId = event.type === "param-mod" ? (event.noteId ?? -1) : -1;
            const perNote = event.type === "param-mod" && (event.key !== undefined || noteId >= 0);
            e.set("param_id", event.id);
            e.set("cookie", NULL);
            e.set("note_id", noteId);
            e.set("port_index", perNote ? 0 : -1);
            e.set("channel", perNote ? (event.channel ?? -1) : -1);
            e.set("key", perNote && event.type === "param-mod" ? (event.key ?? -1) : -1);
            e.set("value", event.value);
            const type = event.type === "param" ? CLAP_EVENT_PARAM_VALUE : CLAP_EVENT_PARAM_MOD;
            this.#writeHeader(at, clap_event_param_value.size, event.at, type);
        } else if (event.type === "gesture-begin" || event.type === "gesture-end") {
            this.wasm.write("u32", at + clap_event_header.size, event.id);
            const type = event.type === "gesture-begin" ? CLAP_EVENT_PARAM_GESTURE_BEGIN : CLAP_EVENT_PARAM_GESTURE_END;
            this.#writeHeader(at, clap_event_param_gesture.size, event.at, type);
        } else if (event.type === "expression") {
            const e = this.#expression.moveTo(asPtr(at));
            e.set("expression_id", event.expression);
            e.set("note_id", event.noteId ?? -1);
            e.set("port_index", 0);
            e.set("channel", event.channel ?? -1);
            e.set("key", event.key);
            e.set("value", event.value);
            this.#writeHeader(at, clap_event_note_expression.size, event.at, CLAP_EVENT_NOTE_EXPRESSION);
        } else if (event.type === "note-on" || event.type === "note-off" || event.type === "note-choke") {
            const e = this.#note.moveTo(asPtr(at));
            e.set("note_id", event.noteId ?? -1);
            e.set("port_index", 0);
            e.set("channel", event.channel ?? 0);
            e.set("key", event.key);
            e.set("velocity", event.velocity);
            const type =
                event.type === "note-on"
                    ? CLAP_EVENT_NOTE_ON
                    : event.type === "note-off"
                      ? CLAP_EVENT_NOTE_OFF
                      : CLAP_EVENT_NOTE_CHOKE;
            this.#writeHeader(at, clap_event_note.size, event.at, type);
        }
    }

    // Every event starts with its header.
    #writeHeader(at: number, size: number, time: number, type: number): void {
        const header = this.#header.moveTo(asPtr(at));
        header.set("size", size);
        header.set("time", time);
        header.set("space_id", CLAP_CORE_EVENT_SPACE_ID);
        header.set("type", type);
        header.set("flags", 0);
    }
}
