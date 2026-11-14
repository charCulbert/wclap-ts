// What a plug-in's process status asks of the next block. SLEEP: skip blocks until an event is due, the input has
// sound, or the plug-in asks to be processed. CONTINUE_IF_NOT_QUIET: sleep after a block whose output is silent.
// TAIL: carry on for the plug-in's clap.tail frames after the last event or sound in, then sleep (an infinite tail
// never sleeps). CONTINUE, ERROR and anything else: carry on.
import {
    CLAP_PROCESS_CONTINUE_IF_NOT_QUIET,
    CLAP_PROCESS_ERROR,
    CLAP_PROCESS_SLEEP,
    CLAP_PROCESS_TAIL,
} from "./clap.generated.ts";

// A tail this long or longer never ends.
const INFINITE = 0x7fffffff;

export class ProcessStatus {
    // Whether the next block is skipped unless something wakes the plug-in.
    asleep = false;
    #tailing = false;
    // Frames processed in the tail since the last event or sound in.
    #tail = 0;
    // Whether the block being processed had an event, sound in, or a process request.
    #woken = false;

    // Before a block: true to skip it. `woken`: events are due in it, or the plug-in asked to be processed. The
    // input is read only while the plug-in sleeps or is in its tail.
    skip(woken: boolean, inputs: readonly Float32Array[][], frames: number): boolean {
        this.#woken = woken || ((this.asleep || this.#tailing) && !silent(inputs, frames));
        if (this.asleep && !this.#woken) return true;
        this.asleep = false;
        return false;
    }

    // After a processed block: its status, its output, and the plug-in's clap.tail (read only for TAIL).
    after(status: number, outputs: readonly Float32Array[][], frames: number, tail: () => number): void {
        if (status === CLAP_PROCESS_SLEEP) this.asleep = true;
        else if (status === CLAP_PROCESS_CONTINUE_IF_NOT_QUIET) this.asleep = silent(outputs, frames);
        else if (status === CLAP_PROCESS_TAIL) {
            this.#tail = this.#woken || !this.#tailing ? 0 : this.#tail + frames;
            // tail.get returns a uint32.
            const length = tail() >>> 0;
            this.asleep = length < INFINITE && this.#tail >= length;
        }
        if (status !== CLAP_PROCESS_ERROR) this.#tailing = status === CLAP_PROCESS_TAIL;
    }

    // Stopped, restarted, reset or back from bypass: process the next block.
    reset(): void {
        this.asleep = false;
        this.#tailing = false;
        this.#tail = 0;
    }
}

function silent(ports: readonly Float32Array[][], frames: number): boolean {
    for (const port of ports)
        for (const channel of port) for (let i = 0; i < frames; i++) if (channel[i] !== 0) return false;
    return true;
}
