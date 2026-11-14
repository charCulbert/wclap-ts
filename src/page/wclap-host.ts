// A host of plug-ins on the page: one AudioWorkletNode with its arrangement (a chain, or yours), the plug-ins in
// it, events in and out on one clock, transport, MIDI, and createChain / createHost.

import { EventQueue, MAX_MIDI_BYTES, type Timed } from "../events/event-queue.ts";
import { Clock } from "../events/live-event-clock.ts";
import { midiLength } from "../plugin/clap-host-callbacks.ts";
import type { StateContext } from "../plugin/plugin-types.ts";
import { canAttach } from "../plugin/wasm-instance.ts";
import { type Bundle, openBundle } from "../plugin/wclap-bundle.ts";
import type { FromThread } from "../runtime/thread.ts";
import type { FromWorker } from "../runtime/worker.ts";
import type { ThreadStart } from "../threads/plugin-spawned-threads.ts";
import type { Started } from "../threads/two-threads.ts";
import type { FromProcessor, Info, ProcessorOptions, Stats } from "../worklet/worklet-host.ts";
import { fetchBytes, Link, modules, nextPluginId, plugins, type Source } from "./message-link.ts";
import { Midi } from "./midi.ts";
import { hideInterface } from "./plugin-interface.ts";
import { Transport } from "./transport.ts";
import { type HostEvents, type MidiOut, type NoteOut, TypedTarget } from "./typed-events.ts";
import { WclapPlugin } from "./wclap-plugin.ts";

export interface ChainOptions {
    // The folder serving wclap-ts's runtime files. By default the folder this library was loaded from, which holds
    // them (node_modules/wclap-ts/dist/, if your server serves node_modules); name another where you copied them
    // with `npx wclap-ts setup`, or where a bundler that moves this file leaves them behind.
    base?: string | URL;
    // Plug-ins' own interfaces run on the page's origin, trusted like any script on it, unless this names the same
    // folder (frame.html, frame.js, sw.js) served from a second origin: each interface then runs there, unable to
    // reach the page. That origin's frame.html must be sent with Cross-Origin-Resource-Policy: cross-origin.
    uiBase?: string | URL;
    // "one" keeps every plug-in on the audio thread even when it could use a Worker. A plug-in on the audio thread
    // also starts there, so adding one to a playing chain can interrupt the audio once (13-26 ms measured for a large
    // one in Chrome). A plug-in on a Worker starts there and doesn't.
    threads?: "auto" | "one";
    // Seconds every live event is delayed by, so it arrives before its frame: lower is less latency, higher
    // survives a busier page. Default two blocks (about 5 ms at 48 kHz).
    lead?: number;
    // The transport its host-synced plug-ins follow; share one between hosts to keep them in step. Its own if left
    // out.
    transport?: Transport;
    // The most memory a plug-in that imports its memory may grow to, in MB; 1024 by default. Phones refuse large
    // shared memories outright, so a plug-in declaring 4 GB still loads. A plug-in with its own memory keeps its own
    // limit.
    maxMemoryMB?: number;
    onLog?: (text: string, plugin?: WclapPlugin) => void;
    onError?: (message: string, plugin?: WclapPlugin) => void;
    onStats?: (stats: Stats) => void;
}

// For your own arrangement of plug-ins (see registerWclapProcessor in wclap-ts/worklet).
export interface HostOptions extends ChainOptions {
    // Your AudioWorklet module, which registers `processor`; base's worklet.js (a Chain) by default.
    module?: string | URL;
    processor?: string;
    // Passed to your MakeTopology as its options.
    topology?: unknown;
    // The node's inputs and output channel counts: 1 and [2] by default.
    inputs?: number;
    outputs?: number[];
}

export interface AddOptions {
    // Which plug-in, when the bundle holds several; the first by default.
    pluginId?: string;
    index?: number;
    threads?: "auto" | "one";
    maxMemoryMB?: number;
}

// Events: "noteout" (CustomEvent<NoteOut>) for notes leaving the last plug-in, "midiout" (CustomEvent<MidiOut>) for
// every MIDI message leaving it (notes too), "latencychange" when the chain's
// latency may have changed (a plug-in reported one, or one was added, removed or bypassed).
export class WclapHost extends TypedTarget<HostEvents> {
    readonly context: BaseAudioContext;
    readonly node: AudioWorkletNode;
    readonly plugins: WclapPlugin[] = [];
    readonly clock: Clock;
    readonly base: URL;
    readonly uiBase: URL | undefined;
    /** @internal */
    readonly options: ChainOptions;
    readonly #queue: EventQueue;
    // Note-offs the queue had no room for, sent as soon as it has: a lost one would leave a note hanging.
    readonly #retry: { frame: number; event: Timed; target: number; live: boolean }[] = [];
    readonly #workers = new Map<number, { worker: Worker; link: Link }>();
    readonly #threads = new Map<number, Set<Worker>>();
    readonly #drain: ReturnType<typeof setInterval>;
    readonly #audio: Link;
    readonly transport: Transport;
    readonly #unfollow: () => void;
    #dropped = 0;
    readonly #midi = new Midi(this);

    static async create(context: BaseAudioContext, options: HostOptions = {}): Promise<WclapHost> {
        if (!globalThis.crossOriginIsolated)
            throw new Error(
                "wclap-ts needs cross-origin isolation: serve the page with Cross-Origin-Opener-Policy: same-origin " +
                    "and Cross-Origin-Embedder-Policy: require-corp, or call isolate() first",
            );
        const base = new URL(String(options.base ?? new URL(".", import.meta.url)), location.href);
        const loaded = modules.get(context) ?? new Map<string, Promise<void>>();
        modules.set(context, loaded);
        const url = new URL(String(options.module ?? new URL("worklet.js", base)), location.href).href;
        if (!loaded.has(url)) loaded.set(url, context.audioWorklet.addModule(url));
        await loaded.get(url);
        return new WclapHost(context, base, options);
    }

    private constructor(context: BaseAudioContext, base: URL, options: HostOptions) {
        super();
        this.context = context;
        this.base = base;
        this.uiBase = options.uiBase === undefined ? undefined : new URL(String(options.uiBase), location.href);
        this.options = options;
        this.#queue = EventQueue.create();
        const back = EventQueue.create();
        const processorOptions: ProcessorOptions = {
            queue: this.#queue.buffer,
            back: back.buffer,
            maxFrames: 128,
            topology: options.topology,
        };
        this.#drain = setInterval(() => {
            this.#sendRetries();
            back.drain((frame, e) => {
                const time = frame / context.sampleRate;
                if (e.type === "param") plugins.get(e.target)?.changed(e.id, e.value, frame);
                else if (e.type === "gesture-begin" || e.type === "gesture-end")
                    plugins.get(e.target)?.gesture(e.id, e.type === "gesture-begin");
                else if (e.type === "midi") this.#midiOut(e.data, time);
                else if (e.type === "note-on" || e.type === "note-off") {
                    const on = e.type === "note-on";
                    const channel = e.channel ?? 0;
                    const note: NoteOut = { on, key: e.key, velocity: e.velocity, channel, time };
                    this.dispatchEvent(new CustomEvent("noteout", { detail: note }));
                    if (e.key < 0 || channel < 0) return;
                    const velocity = Math.min(127, Math.max(on ? 1 : 0, Math.round(e.velocity * 127)));
                    this.#midiOut(Uint8Array.of((on ? 0x90 : 0x80) | channel, e.key, velocity), time);
                }
            });
        }, 10);
        const outputs = options.outputs ?? [2];
        this.node = new AudioWorkletNode(context, options.processor ?? "wclap-chain", {
            numberOfInputs: options.inputs ?? 1,
            numberOfOutputs: outputs.length,
            outputChannelCount: outputs,
            processorOptions,
        });
        this.#audio = new Link(this.node.port);
        this.node.onprocessorerror = () =>
            (options.onError ?? console.error)("the audio thread stopped: its processor threw");
        this.#audio.onOther = (m) => {
            if (m.type === "log") options.onLog?.(m.text);
            else if (m.type === "message") this.dispatchEvent(new CustomEvent("message", { detail: m.data }));
            else if (m.type === "spawn") this.startThread(m.id, m.start);
            else if (m.type === "stats") options.onStats?.({ ...m.stats, dropped: m.stats.dropped + this.#dropped });
            else if (m.type === "failed") {
                const plugin = plugins.get(m.id);
                plugin?.markFailed();
                this.latencyChanged();
                (options.onError ?? console.error)(m.message, plugin);
            } else if (m.type === "error") (options.onError ?? console.error)(m.message, plugins.get(m.id ?? -1));
        };
        this.clock = new Clock(context, options.lead ?? 256 / context.sampleRate);
        this.transport = options.transport ?? new Transport(context);
        this.#unfollow = this.transport.follow((anchor) => this.#audio.post({ type: "transport", anchor }));
    }

    get input(): AudioNode {
        return this.node;
    }

    // Plug-ins with CLAP's render extension are told they render offline.
    get #offline(): boolean {
        return typeof OfflineAudioContext !== "undefined" && this.context instanceof OfflineAudioContext;
    }

    // Each two-thread plug-in's main role gets its own Worker, so one plug-in's slow work never holds up another's.
    #startWorker(id: number): Link {
        const worker = new Worker(new URL("worker.js", this.base), { type: "module" });
        const link = new Link(worker);
        link.onOther = (m) => {
            if (m.type === "spawn") this.startThread(m.id, m.start);
            else if (m.type === "log") this.options.onLog?.(m.text);
            else if (m.type === "error") (this.options.onError ?? console.error)(m.message, plugins.get(m.id ?? -1));
        };
        this.#workers.set(id, { worker, link });
        return link;
    }

    #stopWorker(id: number): void {
        this.#workers.get(id)?.worker.terminate();
        this.#workers.delete(id);
        for (const thread of this.#threads.get(id) ?? []) thread.terminate();
        this.#threads.delete(id);
    }

    // A thread the plug-in started, in a Worker of its own; the threads it starts come back here too.
    // By the plug-in's ID: it may start threads while it starts, before the page knows it.
    /** @internal */
    startThread(id: number, start: ThreadStart): void {
        const thread = new Worker(new URL("thread.js", this.base), { type: "module" });
        const list = this.#threads.get(id) ?? new Set();
        this.#threads.set(id, list.add(thread));
        thread.onmessage = ({ data }: MessageEvent<FromThread>) => {
            if (data.type === "spawn") this.startThread(id, data.start);
            else if (data.type === "log") this.options.onLog?.(data.text, plugins.get(id));
            else {
                if (data.error) (this.options.onError ?? console.error)(data.error, plugins.get(id));
                thread.terminate();
                list.delete(thread);
            }
        };
        thread.postMessage(start);
    }

    // Loads a plug-in into the chain (at the end by default) while it plays.
    async add(source: Source | Bundle, options: AddOptions = {}): Promise<WclapPlugin> {
        const opened =
            typeof source === "object" && "module" in source ? source : await openBundle(await fetchBytes(source));
        const bundle = capMemory(opened, options.maxMemoryMB ?? this.options.maxMemoryMB ?? 1024);
        const id = nextPluginId();
        const threads = options.threads ?? this.options.threads ?? "auto";
        const at = options.index ?? this.plugins.length;
        let plugin: WclapPlugin | undefined;
        let why = threads === "one" ? 'threads: "one" was asked for' : "";
        if (threads === "auto" && !canAttach(bundle))
            why = "it isn't built for two threads (shared memory and the thread exports, see the README)";
        else if (threads === "auto")
            plugin = await this.#addTwo(id, bundle, at, options).catch((error: unknown) => {
                why = `two threads failed: ${error instanceof Error ? error.message : String(error)}`;
                return undefined;
            });
        if (!plugin) {
            const added = await this.#audio.request<Extract<FromProcessor, { type: "added" }>>(
                {
                    type: "add-one",
                    id,
                    index: at,
                    module: bundle.module,
                    memory: bundle.memory,
                    files: bundle.files,
                    ...(options.pluginId ? { pluginId: options.pluginId } : {}),
                    ...(this.#offline ? { offline: true } : {}),
                },
                (m) => m.type === "added" && m.id === id,
            );
            if (!added.info) throw new Error("the plug-in started without describing itself");
            plugin = new WclapPlugin(this, id, added.info, bundle, this.#audio, "one", why);
            this.options.onLog?.(`${added.info.descriptor.name} runs on the audio thread: ${why}`, plugin);
        }
        this.plugins.splice(at, 0, plugin);
        plugins.set(id, plugin);
        this.latencyChanged();
        return plugin;
    }

    async #addTwo(id: number, bundle: Bundle, at: number, options: AddOptions): Promise<WclapPlugin> {
        const worker = this.#startWorker(id);
        let started: Started;
        try {
            ({ started } = await worker.request<Extract<FromWorker, { type: "added" }>>(
                {
                    type: "add",
                    id,
                    options: {
                        module: bundle.module,
                        memory: bundle.memory,
                        files: bundle.files,
                        sampleRate: this.context.sampleRate,
                        maxFrames: 128,
                        ...(options.pluginId ? { pluginId: options.pluginId } : {}),
                        ...(this.#offline ? { offline: true } : {}),
                    },
                },
                (m) => m.type === "added" && m.id === id,
            ));
        } catch (error) {
            this.#stopWorker(id);
            throw error;
        }
        try {
            await this.#audio.request(
                { type: "add-two", id, index: at, audio: started.audio, ports: started.ports },
                (m) => m.type === "added" && m.id === id,
            );
        } catch (error) {
            await worker
                .request({ type: "remove", id }, (m) => m.type === "removed" && m.id === id)
                .catch(() => undefined);
            this.#stopWorker(id);
            throw error;
        }
        const info: Info = { descriptor: started.descriptor, params: started.params, ports: started.ports };
        return new WclapPlugin(this, id, info, bundle, worker, "two");
    }

    async remove(plugin: WclapPlugin): Promise<void> {
        const i = this.plugins.indexOf(plugin);
        if (i < 0) return;
        this.plugins.splice(i, 1);
        plugins.delete(plugin.id);
        hideInterface(plugin);
        const main = this.#workers.get(plugin.id);
        if (main) {
            await main.link.request(
                { type: "remove", id: plugin.id, audioDone: this.context.state === "closed" },
                (m) => m.type === "removed" && m.id === plugin.id,
            );
            this.#stopWorker(plugin.id);
        }
        // A plug-in on the audio thread joins its own threads as it deactivates there; they end by themselves.
        this.#audio.post({ type: "remove", id: plugin.id });
        this.latencyChanged();
    }

    // To your arrangement's Topology.message: routing, levels, whatever it defines.
    send(data: unknown, transfer?: Transferable[]): void {
        this.#audio.post({ type: "message", data }, transfer);
    }

    // Reorders a chain (an arrangement with Topology.move).
    move(plugin: WclapPlugin, index: number): void {
        const i = this.plugins.indexOf(plugin);
        if (i < 0) return;
        this.plugins.splice(i, 1);
        this.plugins.splice(index, 0, plugin);
        this.#audio.post({ type: "move", id: plugin.id, index });
    }

    // The plug-in's audio role is bypassed: audio and notes pass through, nothing is processed.
    setEnabled(plugin: WclapPlugin, on: boolean): void {
        this.#audio.post({ type: "enable", id: plugin.id, on });
        this.latencyChanged();
    }

    /** @internal */
    latencyChanged(): void {
        this.dispatchEvent(new Event("latencychange"));
    }

    #midiOut(data: Uint8Array, time: number): void {
        const detail: MidiOut = { data, time };
        this.dispatchEvent(new CustomEvent("midiout", { detail }));
    }

    #sendRetries(): void {
        while (this.#retry.length) {
            const r = this.#retry[0];
            if (!r || !this.#queue.push(r.frame, r.event, r.target, r.live)) return;
            this.#retry.shift();
        }
    }

    // `when`: AudioContext time for an exact frame; without it, now (constant latency), and the event is live
    // (CLAP_EVENT_IS_LIVE) unless it says otherwise. `target`: a plug-in's id, or -1 for the first plug-in. False if
    // the queue was full and the event dropped; a note-off or choke is never dropped, only sent a little later.
    schedule(event: Timed, when?: number, target = -1, sourceMs = performance.now()): boolean {
        const frame = when === undefined ? this.clock.frameAt(sourceMs) : Math.round(when * this.context.sampleRate);
        const live = event.live ?? when === undefined;
        this.#sendRetries();
        if (this.#queue.push(frame, event, target, live)) return true;
        if (event.type === "note-off" || event.type === "note-choke") {
            this.#retry.push({ frame, event: { ...event }, target, live });
            return true;
        }
        this.#dropped++;
        return false;
    }

    noteOn(key: number, velocity = 1, when?: number, channel = 0): boolean {
        return this.schedule({ type: "note-on", key, velocity, channel }, when);
    }

    noteOff(key: number, velocity = 0, when?: number, channel = 0): boolean {
        return this.schedule({ type: "note-off", key, velocity, channel }, when);
    }

    // Stops every note held on the key at once, with no release (a closed hi-hat cutting off an open one).
    choke(key: number, when?: number, channel = 0): boolean {
        return this.schedule({ type: "note-choke", key, velocity: 0, channel }, when);
    }

    // One raw MIDI message (sysex included, up to MAX_MIDI_BYTES) to the first plug-in, at `when` like noteOn.
    // Note-ons and note-offs become notes, as noteOn and noteOff would. False if it was dropped: the queue was full,
    // or it isn't one whole message.
    midi(bytes: ArrayLike<number>, when?: number): boolean {
        return this.sendMidi(bytes, when, -1);
    }

    /** @internal */
    sendMidi(bytes: ArrayLike<number>, when: number | undefined, target: number, sourceMs?: number): boolean {
        const status = bytes[0] ?? 0;
        const length = status === 0xf0 ? bytes.length : midiLength(status);
        if (status < 0x80 || bytes.length < length) return false;
        if (length > MAX_MIDI_BYTES) {
            this.options.onLog?.(`a ${length}-byte sysex is longer than the ${MAX_MIDI_BYTES} bytes carried: dropped`);
            return false;
        }
        const data = Uint8Array.from({ length }, (_, i) => bytes[i] ?? 0);
        const kind = status & 0xf0;
        const [, key = 0, velocity = 0] = data;
        const channel = status & 0x0f;
        const event: Timed =
            kind === 0x90 && velocity > 0
                ? { type: "note-on", key, velocity: velocity / 127, channel }
                : kind === 0x80 || kind === 0x90
                  ? { type: "note-off", key, velocity: velocity / 127, channel }
                  : { type: "midi", data, offset: 0, size: length };
        return this.schedule(event, when, target, sourceMs);
    }

    // MIDI: every input plays the host; controller knobs move mapped parameters; what leaves goes to an output.
    // Sysex comes in only with `{ sysex: true }`, which asks the browser for sysex access (a prompt in most).
    connectMidi(options: { sysex?: boolean } = {}): Promise<() => void> {
        return this.#midi.connect(options);
    }
    mapCC(cc: number, plugin: WclapPlugin, paramId: number, channel = -1): void {
        this.#midi.mapCC(cc, plugin, paramId, channel);
    }
    unmapCC(cc: number, channel = -1): void {
        this.#midi.unmapCC(cc, channel);
    }
    connectMidiOut(output: MIDIOutput): () => void {
        return this.#midi.connectOut(output);
    }

    // The whole chain's latency, in frames; bypassed plug-ins add none.
    async latency(): Promise<number> {
        let total = 0;
        for (const p of this.plugins) if (p.enabled && !p.failed) total += await p.latency();
        return total;
    }

    async saveState(context?: StateContext): Promise<Uint8Array[]> {
        return Promise.all(this.plugins.map((p) => p.saveState(context)));
    }

    async loadState(states: Uint8Array[], context?: StateContext): Promise<void> {
        await Promise.all(this.plugins.map((p, i) => (states[i] ? p.loadState(states[i], context) : undefined)));
    }

    connect(destination: AudioNode): AudioNode {
        return this.node.connect(destination);
    }

    disconnect(): void {
        this.node.disconnect();
    }

    async destroy(): Promise<void> {
        this.#unfollow();
        for (const p of [...this.plugins]) await this.remove(p);
        clearInterval(this.#drain);
        this.#audio.post({ type: "destroy" });
        this.node.disconnect();
    }
}

// A chain of plug-ins: the default arrangement.
export const createChain = (context: BaseAudioContext, options: ChainOptions = {}): Promise<WclapHost> =>
    WclapHost.create(context, options);

// Plug-ins in your own arrangement: `module` is your AudioWorklet module, which calls registerWclapProcessor
// (wclap-ts/worklet) under the name `processor`.
export const createHost = (
    context: BaseAudioContext,
    options: HostOptions & { module: string | URL; processor: string },
) => WclapHost.create(context, options);

export type { HostEvents as ChainEvents };
// A chain is a host whose arrangement is a Chain.
export { WclapHost as WclapChain };

export function capMemory(bundle: Bundle, megabytes: number): Bundle {
    if (!bundle.memory) return bundle;
    const pages = Math.max(bundle.memory.initial, Math.floor((megabytes * 1024 * 1024) / 65536));
    return { ...bundle, memory: { ...bundle.memory, maximum: Math.min(bundle.memory.maximum, pages) } };
}
