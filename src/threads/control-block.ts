// What the main side and the audio side of one plug-in share besides its memory: where the plug-in is in its
// lifecycle, and the requests the audio side makes of the main side. The audio side never waits on either.
import type { Request } from "../plugin/clap-host-callbacks.ts";

const STATE = 0;
const REQUESTS = 1;
// Requests for the audio side: request_process and params.request_flush.
const AUDIO = 2;

// idle → active (the main side activated; the audio side starts processing on its next block) → stopping (the main
// side asks) → stopped (the audio side stopped processing; the main side may deactivate). failed: the plug-in trapped
// on the audio side; it may have died holding a lock, so neither side calls into it again.
export const State = { idle: 0, active: 1, stopping: 2, stopped: 3, failed: 4 } as const;
export type State = (typeof State)[keyof typeof State];

const BITS: Record<Request, number> = {
    callback: 1,
    restart: 2,
    process: 4,
    "params-flush": 8,
    "params-rescan": 16,
    "state-dirty": 32,
    latency: 64,
    "note-names": 128,
};

export class Control {
    readonly buffer: SharedArrayBuffer;
    readonly #ints: Int32Array;

    static create(): Control {
        return new Control(new SharedArrayBuffer(12));
    }

    constructor(buffer: SharedArrayBuffer) {
        this.buffer = buffer;
        this.#ints = new Int32Array(buffer);
    }

    get state(): State {
        return Atomics.load(this.#ints, STATE) as State;
    }

    set state(state: State) {
        Atomics.store(this.#ints, STATE, state);
        Atomics.notify(this.#ints, STATE);
    }

    // Either side; wakes the main side, or leaves a request for the audio side.
    request(request: Request): void {
        if (request === "process" || request === "params-flush") {
            Atomics.or(this.#ints, AUDIO, BITS[request]);
            return;
        }
        Atomics.or(this.#ints, REQUESTS, BITS[request]);
        Atomics.notify(this.#ints, REQUESTS);
    }

    // Audio side: whether the request was made since the last take.
    takeAudio(request: "process" | "params-flush"): boolean {
        const bit = BITS[request];
        return (Atomics.and(this.#ints, AUDIO, ~bit) & bit) !== 0;
    }

    // Main side: the requests made since the last call.
    take(): Request[] {
        const bits = Atomics.exchange(this.#ints, REQUESTS, 0);
        return (Object.keys(BITS) as Request[]).filter((r) => bits & BITS[r]);
    }

    // Main side: resolves when a request arrives, or after `ms`. Without Atomics.waitAsync (Firefox), it polls.
    waitForRequest(ms: number): Promise<void> {
        if (Atomics.load(this.#ints, REQUESTS) !== 0) return Promise.resolve();
        if (typeof Atomics.waitAsync === "function") {
            return waitAsync(this.#ints, REQUESTS, 0, ms);
        }
        return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    }

    // Main side: resolves true once the state is `state`, or false after `ms`, without blocking the thread.
    async untilState(state: State, ms: number): Promise<boolean> {
        const end = Date.now() + ms;
        for (let current = this.state; current !== state; current = this.state) {
            const left = end - Date.now();
            if (left <= 0) return false;
            if (typeof Atomics.waitAsync === "function") {
                await waitAsync(this.#ints, STATE, current, left);
            } else await new Promise((r) => setTimeout(r, Math.min(left, 5)));
        }
        return true;
    }

    // Main side only (a Worker may block): waits until the state is `state`, at most `ms`; false on timeout.
    waitForState(state: State, ms: number): boolean {
        const end = Date.now() + ms;
        for (let current = this.state; current !== state; current = this.state) {
            const left = end - Date.now();
            if (left <= 0) return false;
            Atomics.wait(this.#ints, STATE, current, left);
        }
        return true;
    }
}

// Atomics.waitAsync, with a timer holding the event loop open until its timeout: Node 22 doesn't count a pending
// waitAsync and exits under it.
async function waitAsync(ints: Int32Array, index: number, value: number, ms: number): Promise<void> {
    const result = Atomics.waitAsync(ints, index, value, ms);
    if (!result.async) return;
    const timer = setTimeout(() => undefined, ms);
    await result.value;
    clearTimeout(timer);
}
