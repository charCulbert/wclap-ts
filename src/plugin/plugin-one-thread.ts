// Both roles of a plug-in on one instance and one thread.
import type { clap_plugin } from "./clap.generated.ts";
import type { OutputList, Request } from "./clap-host-callbacks.ts";
import { PluginAudio } from "./plugin-audio-thread.ts";
import { PluginMain } from "./plugin-main-thread.ts";
import type { Event, Log, ParamInfo, Ports, StateContext, Transport } from "./plugin-types.ts";
import type { Instance } from "./wasm-instance.ts";
import type { Layout, Struct } from "./wasm-struct.ts";

// Both halves on one instance and one thread: the plug-in's main-thread work runs between blocks (idle).
export class Plugin {
    readonly main: PluginMain;
    #audio: PluginAudio | undefined;

    static create(instance: Instance, id: string, log?: Log): Plugin {
        return new Plugin(PluginMain.create(instance, id, log ? { log } : {}));
    }

    // Both halves around a main half already created (with its own options).
    static wrap(main: PluginMain): Plugin {
        return new Plugin(main);
    }

    private constructor(main: PluginMain) {
        this.main = main;
    }

    get instance(): Instance {
        return this.main.instance;
    }
    get plugin(): Struct<typeof clap_plugin> {
        return this.main.plugin;
    }
    get requests(): Set<Request> {
        return this.main.requests;
    }
    get ports(): Ports {
        return this.main.ports;
    }
    // The audio half, once active.
    get audio(): PluginAudio | undefined {
        return this.#audio;
    }

    extension<L extends Layout>(id: string, layout: L): Struct<L> | null {
        return this.main.extension(id, layout);
    }
    params(): ParamInfo[] {
        return this.main.params();
    }
    saveState(context?: StateContext): Uint8Array {
        return this.main.saveState(context);
    }
    loadState(bytes: Uint8Array, context?: StateContext): void {
        this.main.loadState(bytes, context);
    }

    flush(events: readonly Event[], count: number): void {
        this.#audio?.flush(events, count);
    }

    reset(): void {
        this.#audio?.reset();
    }

    activate(sampleRate: number, maxFrames: number): void {
        const setup = this.main.activate(sampleRate, maxFrames);
        const main = this.main;
        this.#audio = new PluginAudio(this.instance.wasm, setup, main.events, main.output, main.thread, (r) =>
            main.takeAudioRequest(r),
        );
    }

    process(
        frames: number,
        events?: readonly Event[],
        inputs?: readonly (readonly Float32Array[])[],
        count?: number,
        transport?: Transport,
    ): Float32Array[][] {
        if (!this.#audio) throw new Error("not active");
        return this.#audio.process(frames, events, inputs, count, transport);
    }

    get output(): OutputList {
        return this.main.output;
    }

    // Main-thread work between blocks, including a restart the plug-in asked for.
    idle(): void {
        if (this.main.requests.delete("restart")) {
            this.#audio?.stop();
            this.main.restart();
        }
        this.main.idle();
    }

    destroy(): void {
        this.#audio?.stop();
        this.main.destroy();
    }
}
