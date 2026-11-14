// One WCLAP module instantiated: its memory, its entry point and plug-in factory, and allocation inside it.

import {
    CLAP_PLUGIN_FACTORY_ID,
    clap_plugin_descriptor,
    clap_plugin_entry,
    clap_plugin_factory,
} from "./clap.generated.ts";
import type { Log } from "./plugin-types.ts";
import { encodeUtf8 } from "./utf8.ts";
import { wasiImports } from "./wasi-imports.ts";
import { asPtr, type Layout, type Ptr, type Struct, Wasm } from "./wasm-struct.ts";
import type { Bundle } from "./wclap-bundle.ts";

const consoleLog: Log = (message) => console.log(message);

export interface Descriptor {
    id: string;
    name: string;
    vendor: string;
    version: string;
    features: string[];
}

interface Exports {
    memory?: WebAssembly.Memory;
    wasi_thread_start?: (tid: number, startArg: number) => void;
    __indirect_function_table: WebAssembly.Table;
    clap_entry: WebAssembly.Global;
    malloc: (size: number) => number;
    _initialize?: () => void;
    __stack_pointer?: WebAssembly.Global;
    __tls_size?: WebAssembly.Global;
    __tls_align?: WebAssembly.Global;
    __wasm_init_tls?: (at: number) => void;
    __wasi_init_tp?: () => void;
}

interface Options {
    log?: Log;
    // The memory to import, made by the caller (so threads can be given it before this returns); else from the bundle.
    memory?: WebAssembly.Memory;
    // What the plug-in's thread-spawn calls; without it, the plug-in can't start threads.
    spawn?: (startArg: number) => number;
}

interface AttachOptions extends Options {
    // The bundle's files, for the plug-in to read under /plugin as the first instance does.
    files?: Map<string, Uint8Array> | undefined;
}

// A stack and a thread-local block in the plug-in's memory, for a second instance of it.
export interface ThreadSetup {
    stack: number;
    tls: number;
    tlsSize: number;
    // From the plug-in's shared thread IDs (spawn.ts), so it never matches a thread the plug-in started.
    tid: number;
}

const THREAD_EXPORTS = ["__stack_pointer", "__tls_size", "__tls_align", "__wasm_init_tls", "__wasi_init_tp"];
const MAIN_TID = 0x3fffffff; // what wasi-libc's __wasi_init_tp writes

// Whether a second instance can run over this module's memory: it must be shared, and the module must export what
// gives that instance its own stack and thread-local storage.
export function canAttach(bundle: Bundle): boolean {
    const names = new Set(WebAssembly.Module.exports(bundle.module).map((e) => e.name));
    return !!bundle.memory?.shared && THREAD_EXPORTS.every((n) => names.has(n));
}

function instantiate(
    module: WebAssembly.Module,
    memory: WebAssembly.Memory | null,
    log: Log,
    files?: Map<string, Uint8Array>,
    spawn?: (startArg: number) => number,
) {
    let wasm: Wasm | undefined;
    const imports = wasiImports(
        module,
        () => {
            if (!wasm) throw new Error("the plug-in called WASI before it was started");
            return wasm;
        },
        log,
        files,
        spawn,
    );
    if (memory) imports.env = { memory };
    const exports = new WebAssembly.Instance(module, imports).exports as unknown as Exports;
    const mem = memory ?? exports.memory;
    if (!mem) throw new Error("the plug-in neither imports nor exports a memory");
    for (const name of ["__indirect_function_table", "clap_entry", "malloc"] as const)
        if (!exports[name]) throw new Error(`the plug-in doesn't export ${name}`);
    wasm = new Wasm(mem, exports.__indirect_function_table);
    return { exports, wasm };
}

export class Instance {
    readonly wasm: Wasm;
    readonly exports: Exports;
    // Only the first instance has one: a second instance never runs the entry point.
    readonly factory: Struct<typeof clap_plugin_factory> | null;

    static create(bundle: Bundle, options: Options = {}): Instance {
        const log = options.log ?? consoleLog;
        const { exports, wasm } = instantiate(
            bundle.module,
            options.memory ?? (bundle.memory && new WebAssembly.Memory(bundle.memory)),
            log,
            bundle.files,
            options.spawn,
        );
        exports._initialize?.();
        const instance = new Instance(exports, wasm, null);
        const entry = wasm.struct(clap_plugin_entry, asPtr(exports.clap_entry.value as number));
        if (!entry.call("init", instance.allocString("/plugin"))) throw new Error("clap_entry.init failed");
        instance.#entry = entry;
        const factory = instance.getFactory(CLAP_PLUGIN_FACTORY_ID);
        if (!factory) throw new Error("the plug-in has no plug-in factory");
        const result = new Instance(exports, wasm, wasm.struct(clap_plugin_factory, asPtr(factory)));
        result.#entry = entry;
        return result;
    }

    #entry: Struct<typeof clap_plugin_entry> | undefined;

    // Another factory from the entry point (presets have their own), or 0. The first instance only.
    getFactory(id: string): number {
        return this.#entry ? (this.#entry.call("get_factory", this.allocString(id)) as number) : 0;
    }

    // A second instance over the first one's memory, for another thread. It skips _initialize (the memory is
    // already set up), takes its own stack and thread-local block, and gets its own thread ID. The ID's place in the
    // block is found by the value libc gives every new thread record; if it isn't there exactly once, this libc
    // keeps it elsewhere and attaching fails rather than guess.
    static attach(
        module: WebAssembly.Module,
        memory: WebAssembly.Memory,
        thread: ThreadSetup,
        options: AttachOptions = {},
    ) {
        const log = options.log ?? consoleLog;
        const { exports, wasm } = instantiate(module, memory, log, options.files, options.spawn);
        const { __stack_pointer, __wasm_init_tls, __wasi_init_tp } = exports;
        if (!__stack_pointer || !__wasm_init_tls || !__wasi_init_tp)
            throw new Error("the plug-in can't run a second instance");
        __stack_pointer.value = thread.stack;
        __wasm_init_tls(thread.tls);
        __wasi_init_tp();
        const view = wasm.view;
        const found: number[] = [];
        for (let at = thread.tls; at + 4 <= thread.tls + thread.tlsSize; at += 4)
            if (view.getUint32(at, true) === MAIN_TID) found.push(at);
        const [tid] = found;
        if (found.length !== 1 || tid === undefined)
            throw new Error(`the thread ID appears ${found.length} times in the thread-local block`);
        view.setUint32(tid, thread.tid, true);
        return new Instance(exports, wasm, null);
    }

    // An instance for a thread the plug-in started: wasi_thread_start, called by startThread, sets up the rest.
    static thread(module: WebAssembly.Module, memory: WebAssembly.Memory, options: AttachOptions = {}): Instance {
        const { exports, wasm } = instantiate(module, memory, options.log ?? consoleLog, options.files, options.spawn);
        if (!exports.wasi_thread_start) throw new Error("the plug-in has no wasi_thread_start");
        return new Instance(exports, wasm, null);
    }

    // Runs the thread the plug-in started, to its end.
    startThread(tid: number, startArg: number): void {
        this.exports.wasi_thread_start?.(tid, startArg);
    }

    private constructor(exports: Exports, wasm: Wasm, factory: Struct<typeof clap_plugin_factory> | null) {
        this.exports = exports;
        this.wasm = wasm;
        this.factory = factory;
    }

    // A stack and thread-local block for a second instance, from the plug-in's own malloc.
    prepareThread(tid: number, stackSize = 256 * 1024): ThreadSetup {
        const size = this.exports.__tls_size?.value as number | undefined;
        const align = (this.exports.__tls_align?.value as number | undefined) ?? 16;
        if (size === undefined) throw new Error("the plug-in has no thread-local storage to set up");
        const tls = this.alloc(size + align);
        const stack = this.alloc(stackSize);
        return {
            tls: Math.ceil(tls / align) * align,
            tlsSize: size,
            stack: Math.floor((stack + stackSize) / 16) * 16,
            tid,
        };
    }

    plugins(): Descriptor[] {
        const list: Descriptor[] = [];
        const factory = this.factory;
        if (!factory) return list;
        for (let i = 0; i < factory.call("get_plugin_count", factory.at); i++) {
            const desc = this.wasm.struct(clap_plugin_descriptor, factory.call("get_plugin_descriptor", factory.at, i));
            const features: string[] = [];
            for (let at = desc.get("features"); at; at = asPtr(at + 4)) {
                const feature = this.wasm.read("u32", at) as number;
                if (!feature) break;
                features.push(this.wasm.string(asPtr(feature)));
            }
            list.push({
                id: desc.string("id"),
                name: desc.string("name"),
                vendor: desc.string("vendor"),
                version: desc.string("version"),
                features,
            });
        }
        return list;
    }

    // Memory inside the plug-in, from its own malloc; never freed, so it lives as long as the instance.
    alloc(size: number): Ptr<"void"> {
        const at = this.exports.malloc(size);
        if (!at) throw new Error(`the plug-in's malloc(${size}) failed`);
        this.wasm.bytes.fill(0, at, at + size);
        return asPtr(at);
    }

    allocStruct<L extends Layout>(layout: L): Struct<L> {
        return this.wasm.struct(layout, asPtr(this.alloc(layout.size)));
    }

    allocString(s: string): Ptr<"char"> {
        const bytes = encodeUtf8(`${s}\0`);
        const at = this.alloc(bytes.length);
        this.wasm.bytes.set(bytes, at);
        return asPtr(at);
    }
}
