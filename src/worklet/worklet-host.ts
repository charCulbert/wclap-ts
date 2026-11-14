// The AudioWorklet side of a host: plug-ins arriving and leaving, their main-thread calls, events in and out,
// transport and stats, around an arrangement of plug-ins (a Topology) that does the rendering. Each plug-in is either
// wholly here (one thread, its main-thread work between blocks) or just its audio role here, on a second instance
// over the memory the Worker's instance made (two threads). Changes apply between blocks.
//
// worklet.ts registers "wclap-chain" with a Chain. For your own arrangement, import registerWclapProcessor from
// wclap-ts/worklet in a module of yours, register it under a name, and pass that module and name to createHost.

import { EventQueue, Scheduler } from "../events/event-queue.ts";
import { Plugin } from "../plugin/plugin-one-thread.ts";
import type { Event, Log, ParamInfo, Ports, Transport } from "../plugin/plugin-types.ts";
import type { Descriptor } from "../plugin/wasm-instance.ts";
import type { Bundle } from "../plugin/wclap-bundle.ts";
import { type FromMain, type MainCall, mainCall } from "../threads/main-thread-calls.ts";
import { AudioSide, type AudioStart, startMain } from "../threads/two-threads.ts";
import { Runner, type Slot } from "./plugin-runner.ts";
import type { HostContext, Topology } from "./topology.ts";
import { type TransportAnchor, TransportClock } from "./transport-clock.ts";

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
          offline?: boolean;
          // Made ready but not routed, for an edit's apply.
          prepare?: boolean;
      }
    | { type: "add-two"; id: number; index?: number; audio: AudioStart; ports: Ports; prepare?: boolean }
    | { type: "apply"; callId: number; steps: EditStep[]; fade: boolean }
    | { type: "discard"; ids: number[] }
    | { type: "remove"; id: number }
    | { type: "move"; id: number; index: number }
    | { type: "enable"; id: number; on: boolean }
    | { type: "transport"; anchor: TransportAnchor }
    | { type: "call"; id: number; callId: number; call: MainCall }
    | { type: "message"; data: unknown }
    | { type: "destroy" };

// One step of an edit, applied in order with the rest on one block boundary.
export type EditStep =
    | { op: "add"; id: number; index?: number }
    | { op: "remove"; id: number }
    | { op: "move"; id: number; index: number }
    | { op: "message"; data: unknown };

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
    | { type: "applied"; callId: number }
    | { type: "failed"; id: number; message: string }
    | { type: "result"; callId: number; value: unknown }
    | { type: "error"; message: string; id?: number; callId?: number }
    | { type: "stats"; stats: Stats }
    | { type: "message"; data: unknown };

const STALL_MS = 20;

// A linear fade over the block, out or in.
function fade(outputs: Float32Array[][], frames: number, out: boolean): void {
    for (const output of outputs)
        for (const channel of output)
            for (let i = 0; i < frames; i++) channel[i] = (channel[i] ?? 0) * (out ? 1 - i / frames : i / frames);
}
const describe = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

class HostProcessor extends Base {
    readonly #chain: Topology;
    readonly #scheduler: Scheduler;
    readonly #runner: Runner;
    readonly #clock = new TransportClock(sampleRate);
    readonly #transport: Transport = this.#clock.transport;
    // Every plug-in here, routed or not.
    readonly #slots = new Map<number, Slot>();
    // Made ready for an edit, not yet routed.
    readonly #prepared = new Map<number, Slot>();
    // An edit waiting for its fade-out block, and whether the next block fades in.
    #fading: Extract<ToProcessor, { type: "apply" }> | null = null;
    #fadeIn = false;
    // Plug-ins taken out, destroyed once a block has run without them.
    readonly #removed: Plugin[] = [];
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
                    const log: Log = (text, severity) => this.#send({ type: "log", id: m.id, text, severity });
                    const processor = new AudioSide(m.audio, log, (start) =>
                        this.#send({ type: "spawn", id: m.id, start }),
                    );
                    const slot = { id: m.id, processor, ports: m.ports, enabled: true, failed: false };
                    if (m.prepare) this.#prepared.set(m.id, slot);
                    else this.#add(slot, m.index);
                    this.#send({ type: "added", id: m.id });
                    return;
                }
                case "remove":
                    this.#remove(m.id);
                    return;
                case "apply":
                    this.#check(m.steps);
                    // Without a fade it applies now, between blocks; with one, after a block fading out.
                    if (m.fade) this.#fading = m;
                    else this.#apply(m);
                    return;
                case "discard":
                    for (const id of m.ids) {
                        this.#prepared.delete(id);
                        this.#local.get(id)?.destroy();
                        this.#local.delete(id);
                    }
                    return;
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
                    this.#clock.push(m.anchor);
                    return;
                case "call": {
                    const plugin = this.#local.get(m.id);
                    if (!plugin) throw new Error(`no plug-in ${m.id} on the audio thread`);
                    const call = m.call;
                    const value =
                        call.call === "set-port-active"
                            ? plugin.setPortActive(call.input, call.index, call.active)
                            : mainCall(plugin.main, call);
                    this.#send({ type: "result", callId: m.callId, value });
                    return;
                }
                case "destroy":
                    this.#destroyed = true;
                    while (this.#removed.length) this.#removed.pop()?.destroy();
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
                ...(m.offline ? { offline: true } : {}),
            },
            {
                log: (text, severity) => this.#send({ type: "log", id, text, severity }),
                onInterfaceMessage: (bytes) => this.#send({ type: "interface-message", id, bytes }, [bytes.buffer]),
                onInterfaceRequest: (request, width, height) => {
                    this.#send({ type: "interface-request", id, request, ...(width ? { width, height } : {}) });
                    return true;
                },
                onChange: (what) => this.#send({ type: "changed", id, what }),
                onSuggestPage: (pageId) => this.#send({ type: "suggest-page", id, pageId }),
            },
            // No spawn here: an AudioWorklet can't block, so the plug-in's pthread_join (or any contended lock) would
            // trap. Its pthread_create fails instead. Threads need the plug-in's main role on a Worker.
        );
        const plugin = Plugin.wrap(main);
        plugin.activate(sampleRate, this.#maxFrames);
        this.#local.set(id, plugin);
        const slot = { id, processor: plugin, ports: main.ports, enabled: true, failed: false };
        if (m.prepare) this.#prepared.set(id, slot);
        else this.#add(slot, m.index);
        this.#send({ type: "added", id, info: { descriptor, params: main.params(), ports: main.ports } });
    }

    #add(slot: Slot, index: number | undefined): void {
        this.#slots.set(slot.id, slot);
        this.#runner.add(slot.id);
        this.#chain.add(slot, index);
    }

    #remove(id: number): void {
        this.#chain.remove(id);
        this.#slots.delete(id);
        this.#runner.remove(id);
        const plugin = this.#local.get(id);
        if (plugin) this.#removed.push(plugin);
        this.#local.delete(id);
    }

    // Before anything changes: an edit applies whole or not at all.
    #check(steps: EditStep[]): void {
        const ids = new Set(this.#slots.keys());
        for (const step of steps) {
            if (step.op === "add") {
                if (!this.#prepared.has(step.id)) throw new Error(`plug-in ${step.id} wasn't prepared`);
                ids.add(step.id);
            } else if (step.op === "remove" && !ids.delete(step.id)) throw new Error(`no plug-in ${step.id} to remove`);
            else if (step.op === "move" && !this.#chain.move)
                throw new Error("this arrangement has no order to move plug-ins in");
        }
    }

    #apply(m: Extract<ToProcessor, { type: "apply" }>): void {
        for (const step of m.steps) {
            if (step.op === "add") {
                const slot = this.#prepared.get(step.id) as Slot;
                this.#prepared.delete(step.id);
                this.#add(slot, step.index);
            } else if (step.op === "remove") this.#remove(step.id);
            else if (step.op === "move") this.#chain.move?.(step.id, step.index);
            else this.#chain.message?.(step.data);
        }
        this.#send({ type: "applied", callId: m.callId });
    }

    #lastError = "";
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this.#destroyed) return false;
        const begin = Date.now();
        const frames = outputs[0]?.[0]?.length ?? 128;
        const t = this.#transport;
        this.#clock.block(currentFrame, frames);
        // A throw out of process() would silence the node for good, with nothing said; a block that throws is
        // silent instead, reported once per kind of error, and the next block tries again.
        try {
            this.#block = this.#scheduler.take(currentFrame, frames);
            t.frame = currentFrame;
            this.#runner.beginBlock();
            this.#chain.render(currentFrame, frames, inputs, outputs);
            this.#runner.endBlock(this.#slots.values(), this.#block.events, this.#block.count);
            if (this.#fadeIn) fade(outputs, frames, false);
            this.#fadeIn = false;
            const edit = this.#fading;
            if (edit) {
                this.#fading = null;
                fade(outputs, frames, true);
                this.#fadeIn = true;
                // Checked again: messages since may have changed what it applies to.
                try {
                    this.#check(edit.steps);
                    this.#apply(edit);
                } catch (error) {
                    this.#send({ type: "error", message: describe(error), callId: edit.callId });
                }
            }
        } catch (error) {
            for (const output of outputs) for (const channel of output) channel.fill(0);
            const message = describe(error);
            if (message !== this.#lastError) {
                this.#lastError = message;
                this.#send({ type: "error", message: `a block failed on the audio thread: ${message}` });
            }
        }
        // A block has run without them.
        while (this.#removed.length) this.#removed.pop()?.destroy();
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
