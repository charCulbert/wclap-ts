// The AudioWorklet side of a host: plug-ins arriving and leaving, their main-thread calls, events in and out,
// transport and stats, around an arrangement of plug-ins (a Topology) that does the rendering. Each plug-in is either
// wholly here (one thread, its main-thread work between blocks) or just its audio role here, on a second instance
// over the memory the Worker's instance made (two threads). Changes apply between blocks.
//
// worklet.ts registers "wclap-chain" with a Chain. For your own arrangement, import registerWclapProcessor from
// wclap-ts/worklet in a module of yours, register it under a name, and pass that module and name to createHost.

import { EventQueue, Scheduler } from "../events/event-queue.ts";
import type { TransportAnchor } from "../page/transport.ts";
import { Plugin } from "../plugin/plugin-one-thread.ts";
import type { Event, ParamInfo, Ports, Transport } from "../plugin/plugin-types.ts";
import type { Descriptor } from "../plugin/wasm-instance.ts";
import type { Bundle } from "../plugin/wclap-bundle.ts";
import { type FromMain, type MainCall, mainCall } from "../threads/main-thread-calls.ts";
import { AudioSide, type AudioStart, startMain } from "../threads/two-threads.ts";
import { Runner, type Slot } from "./plugin-runner.ts";
import type { HostContext, Topology } from "./topology.ts";

declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}
// Only an AudioWorklet has the real one; elsewhere (tests importing a Topology) this module still loads.
const Base: typeof AudioWorkletProcessor =
    (globalThis as { AudioWorkletProcessor?: typeof AudioWorkletProcessor }).AudioWorkletProcessor ??
    (class {} as unknown as typeof AudioWorkletProcessor);
declare function registerProcessor(name: string, processor: new (options: AudioWorkletNodeOptions) => object): void;
declare const sampleRate: number;
declare const currentFrame: number;

export interface ProcessorOptions {
    queue: SharedArrayBuffer;
    // What plug-ins send back to the page: their own parameter changes, and notes leaving the chain.
    back: SharedArrayBuffer;
    maxFrames: number;
    // Whatever the page passed for the arrangement (HostOptions.topology).
    topology?: unknown;
}

// Makes the arrangement, once, when the node is created.
export type MakeTopology = (host: HostContext) => Topology;

export interface Info {
    descriptor: Descriptor;
    params: ParamInfo[];
    ports: Ports;
}

export type ToProcessor =
    | {
          type: "add-one";
          id: number;
          index?: number;
          module: WebAssembly.Module;
          memory: Bundle["memory"];
          files?: Map<string, Uint8Array>;
          pluginId?: string;
      }
    | { type: "add-two"; id: number; index?: number; audio: AudioStart; ports: Ports }
    | { type: "remove"; id: number }
    | { type: "move"; id: number; index: number }
    | { type: "enable"; id: number; on: boolean }
    | { type: "transport"; anchor: TransportAnchor }
    | { type: "call"; id: number; callId: number; call: MainCall }
    | { type: "message"; data: unknown }
    | { type: "destroy" };

export interface Stats {
    late: number;
    dropped: number;
    // Times the audio thread went more than 20 ms between blocks, and the longest gap, in ms.
    stalls: number;
    worstGapMs: number;
    // The longest the whole chain took to render one block, in milliseconds (1 ms resolution).
    worstRenderMs: number;
}

export type FromProcessor =
    | FromMain
    | { type: "added"; id: number; info?: Info }
    | { type: "failed"; id: number; message: string }
    | { type: "result"; callId: number; value: unknown }
    | { type: "error"; message: string; id?: number; callId?: number }
    | { type: "stats"; stats: Stats }
    | { type: "message"; data: unknown };

const STALL_MS = 20;
const describe = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

class HostProcessor extends Base {
    readonly #chain: Topology;
    readonly #scheduler: Scheduler;
    readonly #runner: Runner;
    readonly #transport: Transport = { tempo: 120, playing: true, beats: 0, seconds: 0 };
    // Every plug-in here, routed or not.
    readonly #slots = new Map<number, Slot>();
    // This block's events, taken once; the arrangement's take() gets the same.
    #block: { events: readonly Event[]; count: number } = { events: [], count: 0 };
    readonly #maxFrames: number;
    // Plug-ins wholly on this thread, for their main-thread calls.
    readonly #local = new Map<number, Plugin>();
    #destroyed = false;
    // Events plug-ins sent back that the page's queue had no room for.
    #backDropped = 0;
    #stats: Stats = { late: 0, dropped: 0, stalls: 0, worstGapMs: 0, worstRenderMs: 0 };
    #reported = "";
    #reportedAt = Number.NEGATIVE_INFINITY;
    #lastEnd = 0;

    constructor(options: AudioWorkletNodeOptions, make: MakeTopology) {
        super();
        const o = options.processorOptions as ProcessorOptions;
        this.#maxFrames = o.maxFrames;
        this.#scheduler = new Scheduler(new EventQueue(o.queue));
        this.#runner = new Runner(this.#transport);
        this.#runner.onFailure = (id, error) => this.#send({ type: "failed", id, message: describe(error) });
        const back = new EventQueue(o.back);
        const notesOut = (blockStart: number, notes: readonly Event[], count: number) => {
            for (let i = 0; i < count; i++) {
                const e = notes[i];
                if (e && e.type !== "note-end" && !back.push(blockStart + e.at, e)) this.#backDropped++;
            }
        };
        this.#chain = make({
            sampleRate,
            transport: this.#transport,
            runner: this.#runner,
            events: { take: () => this.#block },
            options: o.topology,
            post: (data) => this.#send({ type: "message", data }),
            notesOut,
        });
        // At the frame they were made on, so the page can tell a report from before its own change to that
        // parameter (or before a state load it finished) and drop it.
        this.#runner.onParams = (id, out) => {
            for (let i = 0; i < out.count; i++) {
                const e = out.events[i];
                if (!e || (e.type !== "param" && e.type !== "gesture-begin" && e.type !== "gesture-end")) continue;
                if (!back.push(currentFrame + e.at, e, id)) this.#backDropped++;
            }
        };
        this.port.onmessage = (message: MessageEvent<ToProcessor>) => this.#receive(message.data);
    }

    #send(message: FromProcessor, transfer?: Transferable[]): void {
        this.port.postMessage(message, transfer ?? []);
    }

    #receive(m: ToProcessor): void {
        try {
            switch (m.type) {
                case "add-one":
                    this.#addOne(m);
                    return;
                case "add-two": {
                    const log = (text: string) => this.#send({ type: "log", id: m.id, text });
                    const processor = new AudioSide(m.audio, log, (start) =>
                        this.#send({ type: "spawn", id: m.id, start }),
                    );
                    this.#add({ id: m.id, processor, ports: m.ports, enabled: true, failed: false }, m.index);
                    this.#send({ type: "added", id: m.id });
                    return;
                }
                case "remove": {
                    this.#chain.remove(m.id);
                    this.#slots.delete(m.id);
                    this.#runner.remove(m.id);
                    this.#local.get(m.id)?.destroy();
                    this.#local.delete(m.id);
                    return;
                }
                case "move":
                    if (!this.#chain.move) throw new Error("this arrangement has no order to move plug-ins in");
                    this.#chain.move(m.id, m.index);
                    return;
                case "message":
                    this.#chain.message?.(m.data);
                    return;
                case "enable": {
                    // The host keeps bypass state, so it holds before a plug-in is routed, and the arrangement
                    // hears of it for its routing.
                    const slot = this.#slots.get(m.id);
                    if (slot) this.#runner.setEnabled(slot, m.on);
                    this.#chain.setEnabled?.(m.id, m.on);
                    return;
                }
                case "transport":
                    // In frame order: changes are sent as they're made, each at or after the last.
                    this.#anchors.push(m.anchor);
                    return;
                case "call": {
                    const plugin = this.#local.get(m.id);
                    if (!plugin) throw new Error(`no plug-in ${m.id} on the audio thread`);
                    this.#send({ type: "result", callId: m.callId, value: mainCall(plugin.main, m.call) });
                    return;
                }
                case "destroy":
                    this.#destroyed = true;
                    for (const [id, plugin] of this.#local) {
                        this.#chain.remove(id);
                        this.#slots.delete(id);
                        plugin.destroy();
                    }
                    this.#local.clear();
            }
        } catch (error) {
            const id = "id" in m ? m.id : undefined;
            const callId = "callId" in m ? m.callId : undefined;
            this.#send({
                type: "error",
                message: describe(error),
                ...(id === undefined ? {} : { id }),
                ...(callId === undefined ? {} : { callId }),
            });
        }
    }

    #addOne(m: Extract<ToProcessor, { type: "add-one" }>): void {
        const id = m.id;
        const { plugin: main, descriptor } = startMain(
            {
                module: m.module,
                memory: m.memory,
                sampleRate,
                maxFrames: this.#maxFrames,
                ...(m.files ? { files: m.files } : {}),
                ...(m.pluginId ? { pluginId: m.pluginId } : {}),
            },
            {
                log: (text) => this.#send({ type: "log", id, text }),
                onInterfaceMessage: (bytes) => this.#send({ type: "interface-message", id, bytes }, [bytes.buffer]),
                onInterfaceRequest: (request, width, height) => {
                    this.#send({ type: "interface-request", id, request, ...(width ? { width, height } : {}) });
                    return true;
                },
                onChange: (what) => this.#send({ type: "changed", id, what }),
            },
            // No spawn here: an AudioWorklet can't block, so the plug-in's pthread_join (or any contended lock) would
            // trap. Its pthread_create fails instead. Threads need the plug-in's main role on a Worker.
        );
        const plugin = Plugin.wrap(main);
        plugin.activate(sampleRate, this.#maxFrames);
        this.#local.set(id, plugin);
        this.#add({ id, processor: plugin, ports: main.ports, enabled: true, failed: false }, m.index);
        this.#send({ type: "added", id, info: { descriptor, params: main.params(), ports: main.ports } });
    }

    #add(slot: Slot, index: number | undefined): void {
        this.#slots.set(slot.id, slot);
        this.#runner.add(slot.id);
        this.#chain.add(slot, index);
    }

    #lastError = "";
    #anchor: TransportAnchor = {
        frame: 0,
        beats: 0,
        seconds: 0,
        tempo: 120,
        playing: true,
        numerator: 4,
        denominator: 4,
    };
    readonly #anchors: TransportAnchor[] = [];

    // The song position at this block's start, from the latest anchor whose frame has come: every host following
    // one page Transport works it out the same way, so they agree to the frame.
    #followAnchor(t: Transport, frame: number): void {
        while (this.#anchors.length && (this.#anchors[0]?.frame ?? Infinity) <= frame)
            this.#anchor = this.#anchors.shift() ?? this.#anchor;
        const a = this.#anchor;
        const elapsed = a.playing ? Math.max(0, frame - a.frame) / sampleRate : 0;
        t.tempo = a.tempo;
        t.playing = a.playing;
        t.numerator = a.numerator;
        t.denominator = a.denominator;
        t.beats = a.beats + (elapsed * a.tempo) / 60;
        t.seconds = a.seconds + elapsed;
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this.#destroyed) return false;
        const begin = Date.now();
        const frames = outputs[0]?.[0]?.length ?? 128;
        const t = this.#transport;
        this.#followAnchor(t, currentFrame);
        // A throw out of process() would silence the node for good, with nothing said; a block that throws is
        // silent instead, reported once per kind of error, and the next block tries again.
        try {
            this.#block = this.#scheduler.take(currentFrame, frames);
            t.frame = currentFrame;
            this.#runner.beginBlock();
            this.#chain.render(currentFrame, frames, inputs, outputs);
            this.#runner.endBlock(this.#slots.values(), this.#block.events, this.#block.count);
        } catch (error) {
            for (const output of outputs) for (const channel of output) channel.fill(0);
            const message = describe(error);
            if (message !== this.#lastError) {
                this.#lastError = message;
                this.#send({ type: "error", message: `a block failed on the audio thread: ${message}` });
            }
        }
        const gap = this.#lastEnd ? begin - this.#lastEnd : 0;
        this.#lastEnd = Date.now();
        const s = this.#stats;
        if (gap > STALL_MS) s.stalls++;
        if (gap > s.worstGapMs) s.worstGapMs = gap;
        if (this.#lastEnd - begin > s.worstRenderMs) s.worstRenderMs = this.#lastEnd - begin;
        s.late = this.#scheduler.late;
        s.dropped = this.#scheduler.dropped + this.#backDropped;
        if (currentFrame - this.#reportedAt >= sampleRate) {
            const key = `${s.late} ${s.dropped} ${s.stalls} ${s.worstGapMs} ${s.worstRenderMs}`;
            if (key !== this.#reported) {
                this.#reported = key;
                this.#send({ type: "stats", stats: { ...s } });
            }
            this.#reportedAt = currentFrame;
        }
        return true;
    }
}

// Registers an AudioWorklet processor that hosts plug-ins in the arrangement `make` returns.
export function registerWclapProcessor(name: string, make: MakeTopology): void {
    registerProcessor(
        name,
        class extends HostProcessor {
            constructor(options: AudioWorkletNodeOptions) {
                super(options, make);
            }
        },
    );
}
