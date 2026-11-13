// One plug-in on two threads: MainThread runs CLAP's main-thread role on one instance (in a Worker), AudioSide the
// audio role on a second instance over the same memory (a slot in the AudioWorklet's chain). They share the
// memory and a Control block; the audio side never waits on the main side.

import { installHost, OutputList } from "../plugin/clap-host-callbacks.ts";
import { PluginAudio } from "../plugin/plugin-audio-thread.ts";
import { PluginMain } from "../plugin/plugin-main-thread.ts";
import type { AudioSetup, Event, MainOptions, ParamInfo, Ports, Transport } from "../plugin/plugin-types.ts";
import { type Descriptor, Instance, type ThreadSetup } from "../plugin/wasm-instance.ts";
import type { Bundle } from "../plugin/wclap-bundle.ts";
import type { Processor } from "../worklet/plugin-runner.ts";
import { Control, State } from "./control-block.ts";
import { type Spawn, spawner, ThreadIds } from "./plugin-spawned-threads.ts";

export interface StartOptions {
    module: WebAssembly.Module;
    memory: Bundle["memory"];
    files?: Map<string, Uint8Array>;
    sampleRate: number;
    maxFrames: number;
    pluginId?: string;
}

// Everything the audio side needs; all of it can be posted to another thread.
export interface AudioStart {
    module: WebAssembly.Module;
    memory: WebAssembly.Memory;
    thread: ThreadSetup;
    setup: AudioSetup;
    control: SharedArrayBuffer;
    ids: SharedArrayBuffer;
}

export interface Started {
    descriptor: Descriptor;
    params: ParamInfo[];
    ports: Ports;
    audio: AudioStart;
}

export interface Started1 {
    plugin: PluginMain;
    descriptor: Descriptor;
    // Shared by every instance of this plug-in: requests to the main side, and thread IDs.
    control: Control;
    ids: ThreadIds;
}

// Creates a plug-in from a bundle on this thread. With `spawn`, a plug-in with shared memory can start threads.
export function startMain(
    options: StartOptions,
    main: MainOptions,
    extra: { control?: Control; spawn?: Spawn } = {},
): Started1 {
    const control = extra.control ?? Control.create();
    const ids = ThreadIds.create();
    const memory = options.memory ? new WebAssembly.Memory(options.memory) : undefined;
    let plugin: PluginMain | undefined;
    const spawn =
        memory && options.memory?.shared && extra.spawn
            ? spawner(
                  () => ({
                      module: options.module,
                      memory,
                      files: options.files,
                      control: control.buffer,
                      ids: ids.buffer,
                      extensions: plugin?.hostExtensions() ?? [],
                  }),
                  extra.spawn,
              )
            : undefined;
    const instance = Instance.create(
        { module: options.module, memory: options.memory, files: options.files ?? new Map() },
        { ...(main.log ? { log: main.log } : {}), ...(memory ? { memory } : {}), ...(spawn ? { spawn } : {}) },
    );
    const descriptors = instance.plugins();
    const descriptor = options.pluginId ? descriptors.find((d) => d.id === options.pluginId) : descriptors[0];
    if (!descriptor) throw new Error(`no plug-in ${options.pluginId ?? ""} in this WCLAP`);
    plugin = PluginMain.create(instance, descriptor.id, { ...main, control });
    return { plugin, descriptor, control, ids };
}

export class MainThread {
    readonly plugin: PluginMain;
    readonly control: Control;
    #serving: Promise<void> | undefined;
    #stopped = false;

    // Creates and activates the plug-in on this thread, and readies a second instance for the audio side.
    static start(options: StartOptions, main: MainOptions, spawn?: Spawn): { main: MainThread; started: Started } {
        const control = Control.create();
        const { plugin, descriptor, ids } = startMain(
            options,
            {
                ...main,
                onRequest: (r) => {
                    control.request(r);
                    main.onRequest?.(r);
                },
            },
            { control, ...(spawn ? { spawn } : {}) },
        );
        const thread = plugin.instance.prepareThread(ids.next());
        const setup = plugin.activate(options.sampleRate, options.maxFrames);
        control.state = State.active;
        const result = new MainThread(plugin, control);
        const memory = plugin.instance.wasm.memory;
        const audio = { module: options.module, memory, thread, setup, control: control.buffer, ids: ids.buffer };
        return { main: result, started: { descriptor, params: plugin.params(), ports: plugin.ports, audio } };
    }

    private constructor(plugin: PluginMain, control: Control) {
        this.plugin = plugin;
        this.control = control;
    }

    #failed(): boolean {
        return this.control.state === State.failed;
    }

    // Serves the plug-in's requests until stop(): main-thread callbacks, and restarts.
    serve(): Promise<void> {
        this.#serving ??= (async () => {
            while (!this.#stopped && !this.#failed()) {
                await this.control.waitForRequest(250);
                for (const request of this.control.take()) this.plugin.requests.add(request);
                if (this.#stopped || this.#failed()) break;
                if (this.plugin.requests.has("restart") && (await this.#pause(1000))) {
                    this.plugin.requests.delete("restart");
                    this.plugin.restart();
                    this.control.state = State.active;
                }
                this.plugin.idle();
            }
        })();
        return this.#serving;
    }

    // Asks the audio side to stop processing and waits for it, at most `ms`, without blocking.
    #pause(ms: number): Promise<boolean> {
        this.control.state = State.stopping;
        return this.control.untilState(State.stopped, ms);
    }

    // If the audio side doesn't confirm in time (the AudioContext may be suspended), or it failed, the plug-in isn't
    // touched again: destroying it while the audio side might still call it would be worse than leaking it.
    // `audioDone`: the audio thread will never run again (an OfflineAudioContext that finished, a closed context),
    // so there's no one to answer and nothing to race with.
    async stop(ms = 2000, audioDone = false): Promise<boolean> {
        this.#stopped = true;
        const stopped = !this.#failed() && (audioDone || (await this.#pause(ms)));
        await this.#serving;
        if (stopped) this.plugin.destroy();
        return stopped;
    }

    // Throws if the audio side failed: main-thread calls must not go into a plug-in that may hold a lock.
    check(): void {
        if (this.#failed()) throw new Error("the plug-in failed on the audio thread");
    }
}

// The audio half of a plug-in on two threads, as a slot in the chain: processes while active, stops when asked,
// passes through otherwise. A trap marks the plug-in failed for the main side.
export class AudioSide implements Processor {
    readonly audio: PluginAudio;
    readonly control: Control;
    readonly output = new OutputList();

    // Throws if the second instance can't be attached; the caller falls back to one instance.
    constructor(start: AudioStart, log: (text: string) => void, spawn?: Spawn) {
        const base = () => ({
            module: start.module,
            memory: start.memory,
            control: start.control,
            ids: start.ids,
            extensions: start.setup.extensions,
        });
        const instance = Instance.attach(start.module, start.memory, start.thread, {
            log,
            ...(spawn ? { spawn: spawner(base, spawn) } : {}),
        });
        this.control = new Control(start.control);
        const events = { at: 0, count: 0 };
        const slots = installHost(instance.wasm, {
            events,
            output: this.output,
            extensions: new Map(start.setup.extensions),
            request: (r) => this.control.request(r),
            log: (severity, message) => log(`[${severity}] ${message}`),
            isAudioThread: () => true,
            isMainThread: () => false,
            webviewSend: () => false,
            gui: () => false,
        });
        if (slots.join() !== start.setup.slots.join())
            throw new Error("the host's table slots differ between instances");
        this.audio = new PluginAudio(instance.wasm, start.setup, events, this.output, { audio: true });
    }

    // While bypassed it isn't processed, so a stop the main side asks for (a restart, removal) is answered here.
    idle(): void {
        if (this.control.state !== State.stopping) return;
        this.#guard(() => this.audio.stop());
        this.control.state = State.stopped;
    }

    reset(): void {
        if (this.control.state === State.active) this.#guard(() => this.audio.reset());
    }

    // A trap marks the plug-in failed for the main side too, which then stops waiting on it.
    #guard(f: () => void): void {
        try {
            f();
        } catch (error) {
            this.control.state = State.failed;
            throw error;
        }
    }

    flush(events: readonly Event[], count: number): void {
        if (this.control.state !== State.active) {
            this.output.count = 0;
            return;
        }
        try {
            this.audio.flush(events, count);
        } catch (error) {
            this.control.state = State.failed;
            throw error;
        }
    }

    process(
        frames: number,
        events: readonly Event[],
        inputs: readonly (readonly Float32Array[])[],
        count: number,
        transport: Transport,
    ): Float32Array[][] | null {
        try {
            const state = this.control.state;
            if (state === State.active) return this.audio.process(frames, events, inputs, count, transport);
            if (state === State.stopping) {
                this.audio.stop();
                this.control.state = State.stopped;
            }
            return null;
        } catch (error) {
            this.control.state = State.failed;
            throw error;
        }
    }
}
