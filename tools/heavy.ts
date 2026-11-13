// Heavy Main for 3 s in real time, its state loaded 5 times: on the audio thread (one instance) or from a worker
// thread (two instances). Counts the blocks that miss their deadline. `node tools/heavy.ts one|two`
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { AudioSide, type Started } from "../src/threads/two-threads.ts";
import { Chain } from "../src/worklet/chain.ts";

const mode = process.argv[2] === "one" ? "one" : "two";
const rate = 48000;
const frames = 128;
const blocks = 1125;
const loadsAt = process.env.NOLOAD ? [] : [60, 130, 200, 270, 340];
const blockMs = (frames / rate) * 1000;

const bundle = await openBundle(readFileSync(new URL("../test/fixtures/HeavyMain.wclap.tar.gz", import.meta.url)));
const chain = new Chain(new Scheduler(EventQueue.create()), rate);
const input = [[new Float32Array(frames), new Float32Array(frames)]];
const output = [[new Float32Array(frames), new Float32Array(frames)]];
const loads: number[] = [];

let render: (blockStart: number) => void;
let load: () => void;
let finish = async () => undefined as unknown;

if (mode === "one") {
    const instance = Instance.create(bundle, { log: () => undefined });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    plugin.activate(rate, frames);
    const state = plugin.saveState();
    chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    render = (blockStart) => chain.render(blockStart, frames, input, output);
    load = () => {
        const begin = performance.now();
        plugin.loadState(state);
        loads.push(performance.now() - begin);
    };
    finish = async () => plugin.destroy();
} else {
    const worker = new Worker(new URL("./heavy-worker.ts", import.meta.url));
    const reply = <T>() => new Promise<T>((resolve) => worker.once("message", resolve));
    worker.postMessage({
        start: { module: bundle.module, memory: bundle.memory, sampleRate: rate, maxFrames: frames },
    });
    const { started, state } = await reply<{ started: Started; state: Uint8Array }>();
    const audio = new AudioSide(started.audio, () => undefined);
    chain.add({ id: 1, processor: audio, ports: started.ports, enabled: true, failed: false });
    worker.on("message", (m: { loaded?: number }) => {
        if (m.loaded !== undefined) loads.push(m.loaded);
    });
    render = (blockStart) => chain.render(blockStart, frames, input, output);
    load = () => worker.postMessage({ load: state });
    finish = async () => {
        const stopped = new Promise((resolve) =>
            worker.on("message", (m: { stopped?: boolean }) => m.stopped !== undefined && resolve(m.stopped)),
        );
        worker.postMessage({ stop: true });
        // The audio side keeps rendering until it sees "stopping".
        for (let b = 0; b < 2000 && audio.control.state !== 3; b++) {
            render(0);
            await new Promise((r) => setTimeout(r, 1));
        }
        await stopped;
        await worker.terminate();
    };
}

// A sound card's clock: block i is due at start + i blocks. A block more than one block late is a dropout; its
// lateness is heard as silence, and the clock restarts from it.
const sleep = new Int32Array(new SharedArrayBuffer(4));
let start = performance.now();
let dropouts = 0;
let silenceMs = 0;
let worstMs = 0;
let peak = 0;
for (let i = 0, due = 0; i < blocks; i++, due++) {
    const wait = start + due * blockMs - performance.now();
    if (wait > 0) Atomics.wait(sleep, 0, 0, wait);
    if (loadsAt.includes(i)) load();
    const begin = performance.now();
    render(i * frames);
    const took = performance.now() - begin;
    worstMs = Math.max(worstMs, took);
    for (const v of output[0]?.[0] ?? []) peak = Math.max(peak, Math.abs(v));
    const late = performance.now() - (start + (due + 1) * blockMs);
    if (late > blockMs) {
        dropouts++;
        if (process.env.TRACE) console.log("dropout at block", i, "late", late.toFixed(2), "took", took.toFixed(2));
        silenceMs += late;
        start = performance.now();
        due = -1;
    }
    // Let the worker's messages in.
    if (mode === "two" && i % 32 === 0) await new Promise((r) => setImmediate(r));
}
await finish();
console.log(
    JSON.stringify({
        mode,
        dropouts,
        silenceMs: Math.round(silenceMs),
        worstBlockMs: +worstMs.toFixed(2),
        loadsMs: loads.map((l) => Math.round(l)),
        peak: +peak.toFixed(3),
    }),
);
