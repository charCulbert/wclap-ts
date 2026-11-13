import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import type { ThreadStart } from "../src/threads/plugin-spawned-threads.ts";
import { startMain } from "../src/threads/two-threads.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a plug-in's pthread_create runs a thread on its memory, and joins it again", async () => {
    const bundle = await openBundle(readFileSync(new URL("fixtures/Spawner.wasm", import.meta.url)));
    const exits: Promise<unknown>[] = [];
    const started: number[] = [];
    const spawn = (start: ThreadStart) => {
        started.push(start.tid);
        const worker = new Worker(new URL("thread-worker.ts", import.meta.url), { workerData: start });
        exits.push(
            new Promise((resolve, reject) => {
                worker.on("message", (m: { type: string; start?: ThreadStart }) => {
                    if (m.type === "spawn" && m.start) spawn(m.start);
                });
                worker.on("error", reject);
                worker.on("exit", resolve);
            }),
        );
    };
    const { plugin: main } = startMain(
        { module: bundle.module, memory: bundle.memory, files: bundle.files, sampleRate: 48000, maxFrames: 128 },
        { log: () => undefined },
        { spawn },
    );
    const plugin = Plugin.wrap(main);
    plugin.activate(48000, 128);
    assert.deepEqual(started, [1], "the first thread gets ID 1");

    let value = 0;
    for (let i = 0; i < 400 && value === 0; i++) {
        value = plugin.process(128)[0]?.[0]?.[0] ?? 0;
        await sleep(5);
    }
    assert.ok(value > 0, "the thread did the work process() asked of it");

    plugin.destroy();
    await Promise.race([Promise.all(exits), sleep(5000).then(() => assert.fail("the thread never ended"))]);
});

test("without shared memory or a way to start threads, thread-spawn refuses", async () => {
    const bundle = await openBundle(readFileSync(new URL("fixtures/Spawner.wasm", import.meta.url)));
    const { plugin: main } = startMain(
        { module: bundle.module, memory: bundle.memory, files: bundle.files, sampleRate: 48000, maxFrames: 128 },
        { log: () => undefined },
    );
    assert.throws(() => Plugin.wrap(main).activate(48000, 128), /activate failed/);
});
