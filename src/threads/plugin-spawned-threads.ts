// Threads a plug-in starts itself (wasi-threads' thread-spawn, behind pthread_create). Each runs in its own Worker,
// on a fresh instance over the plug-in's shared memory, entered through the module's own wasi_thread_start, which
// sets up the stack and thread-local storage libc gave it.
import { installHost, OutputList } from "../plugin/clap-host-callbacks.ts";
import { Instance } from "../plugin/wasm-instance.ts";
import { Control } from "./control-block.ts";

// Thread IDs for one plug-in, shared by all its instances. wasi-libc gives its first thread 0x3fffffff so that IDs
// a host hands out (1 to 0x1fffffff, as wasi-threads allows) never collide with it.
export class ThreadIds {
    readonly buffer: SharedArrayBuffer;
    readonly #ids: Int32Array;

    static create(): ThreadIds {
        return new ThreadIds(new SharedArrayBuffer(4));
    }

    constructor(buffer: SharedArrayBuffer) {
        this.buffer = buffer;
        this.#ids = new Int32Array(buffer);
    }

    // -1 once they run out.
    next(): number {
        const id = Atomics.add(this.#ids, 0, 1) + 1;
        return id <= 0x1fffffff ? id : -1;
    }
}

// Everything a new thread needs; all of it can be posted.
export interface ThreadStart {
    module: WebAssembly.Module;
    memory: WebAssembly.Memory;
    files?: Map<string, Uint8Array> | undefined;
    // Requests the plug-in makes from the thread reach its main side here.
    control: SharedArrayBuffer;
    ids: SharedArrayBuffer;
    // The host's extensions as the main instance wrote them, if it has yet.
    extensions: [string, number][];
    tid: number;
    startArg: number;
}

export type Spawn = (start: ThreadStart) => void;

// The plug-in's thread-spawn: a thread ID at once, and the thread itself when `spawn` gets it running. `base` is
// read when the plug-in calls, since a plug-in may start threads before the host is fully set up.
export function spawner(base: () => Omit<ThreadStart, "tid" | "startArg">, spawn: Spawn): (startArg: number) => number {
    return (startArg) => {
        const b = base();
        const tid = new ThreadIds(b.ids).next();
        if (tid > 0) spawn({ ...b, tid, startArg });
        return tid;
    };
}

// Runs a spawned thread to its end on this thread. Threads it starts in turn go to `spawn` too.
export function runThread(start: ThreadStart, log: (text: string) => void, spawn: Spawn): void {
    const control = new Control(start.control);
    const { tid: _, startArg: __, ...base } = start;
    const instance = Instance.thread(start.module, start.memory, {
        log,
        files: start.files,
        spawn: spawner(() => base, spawn),
    });
    installHost(instance.wasm, {
        events: { at: 0, count: 0 },
        output: new OutputList(0),
        extensions: new Map(start.extensions),
        request: (r) => control.request(r),
        log: (severity, message) => log(`[${severity}] ${message}`),
        isAudioThread: () => false,
        isMainThread: () => false,
        webviewSend: () => false,
        gui: () => false,
    });
    instance.startThread(start.tid, start.startArg);
}
