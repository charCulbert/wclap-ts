// A plug-in's process status: which blocks are skipped, and what wakes it. The rules on their own, then the
// process-lifecycle test plug-in through a chain, bypass and restart, and the two-thread request path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import {
    CLAP_PROCESS_CONTINUE,
    CLAP_PROCESS_CONTINUE_IF_NOT_QUIET,
    CLAP_PROCESS_ERROR,
    CLAP_PROCESS_SLEEP,
    CLAP_PROCESS_TAIL,
} from "../src/plugin/clap.generated.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { ProcessStatus } from "../src/plugin/process-status.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Control } from "../src/threads/control-block.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, TEST_PLUGINS } from "./fetch-fixture.ts";

const quiet = [[new Float32Array(128)]];
const loud = [[new Float32Array(128).fill(0.5)]];

// Runs blocks through the rules: each block's status, input and output; returns which blocks were skipped.
function run(status: ProcessStatus, blocks: { status: number; input?: Float32Array[][]; woken?: boolean }[], tail = 0) {
    return blocks.map((b) => {
        const skip = status.skip(b.woken ?? false, b.input ?? quiet, 128);
        if (!skip) status.after(b.status, quiet, 128, () => tail);
        return skip;
    });
}

test("CONTINUE_IF_NOT_QUIET sleeps after a silent block, until sound comes in", () => {
    const s = new ProcessStatus();
    const block = { status: CLAP_PROCESS_CONTINUE_IF_NOT_QUIET };
    assert.deepEqual(run(s, [block, block, { ...block, input: loud }, block]), [false, true, false, true]);
    // An output with sound keeps it awake.
    s.reset();
    s.after(CLAP_PROCESS_CONTINUE_IF_NOT_QUIET, loud, 128, () => 0);
    assert.equal(s.asleep, false);
});

test("TAIL carries on for the tail's length after the last sound in, then sleeps", () => {
    const s = new ProcessStatus();
    const tail = { status: CLAP_PROCESS_TAIL };
    // 256 frames: the block with sound, two more, then asleep; sound in starts the tail again.
    const blocks = [{ ...tail, input: loud }, tail, tail, tail, { ...tail, input: loud }, tail, tail, tail];
    assert.deepEqual(run(s, blocks, 256), [false, false, false, true, false, false, false, true]);
    // A tail that isn't a whole number of blocks ends after the block it ends in.
    s.reset();
    assert.deepEqual(run(s, [tail, tail, tail, tail], 200), [false, false, false, true]);
});

test("an infinite tail never sleeps; read as unsigned", () => {
    for (const length of [0x7fffffff, -1]) {
        const s = new ProcessStatus();
        const blocks = Array.from({ length: 50 }, () => ({ status: CLAP_PROCESS_TAIL }));
        assert.ok(!run(s, blocks, length).includes(true), `${length}`);
    }
});

test("SLEEP: skipped until an event, sound in, or a process request; ERROR and CONTINUE carry on", () => {
    const s = new ProcessStatus();
    const sleep = { status: CLAP_PROCESS_SLEEP };
    assert.deepEqual(run(s, [sleep, sleep, { ...sleep, woken: true }, sleep, { ...sleep, input: loud }, sleep]), [
        false,
        true,
        false,
        true,
        false,
        true,
    ]);
    assert.deepEqual(run(s, [{ status: CLAP_PROCESS_ERROR, woken: true }, sleep]), [false, false]);
    assert.deepEqual(run(s, [{ status: CLAP_PROCESS_CONTINUE, woken: true }, { status: CLAP_PROCESS_CONTINUE }]), [
        false,
        false,
    ]);
    s.after(CLAP_PROCESS_SLEEP, quiet, 128, () => 0);
    s.reset();
    assert.equal(s.skip(false, quiet, 128), false, "a reset wakes it");
});

const lifecycle = async () => {
    const fixture = TEST_PLUGINS.find((f) => f.name === "process-lifecycle");
    assert.ok(fixture);
    const instance = Instance.create(await openBundle(await fetchFixture(fixture)), { log: () => undefined });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    plugin.activate(48000, 128);
    return plugin;
};

// process-lifecycle's output 1 is how far steady_time moved since its previous call, / 65536.
test("request_process wakes a sleeping plug-in for one block; skipped blocks move steady_time on", async () => {
    const plugin = await lifecycle();
    const block = () => {
        const out = plugin.process(128);
        return [plugin.audio?.skipped, out[0]?.[0]?.[0], out[1]?.[0]?.[0]];
    };
    assert.deepEqual(block(), [false, Math.fround(0.1), 0], "start-up: asks for a callback, sleeps");
    assert.deepEqual(block(), [true, 0, 0], "asleep: the callback hasn't run");
    assert.deepEqual(block(), [true, 0, 0]);
    plugin.idle(); // on_main_thread: request_process
    // 384 frames since its last call, not 128: the two skipped blocks count.
    assert.deepEqual(block(), [false, Math.fround(0.2), 384 / 65536], "woken; steady_time counts skipped blocks");
    assert.deepEqual(block(), [true, 0, 0], "and asleep again");
    plugin.destroy();
});

test("a reset reaches the plug-in, which starts its steady_time comparison over; it still grows by each block", async () => {
    const plugin = await lifecycle();
    const steady = (key?: number) =>
        plugin.process(128, key ? [{ at: 0, type: "note-on", key, velocity: 1 }] : [])[1]?.[0]?.[0];
    steady();
    steady(); // asleep: skipped
    assert.equal(steady(63), 256 / 65536, "key 63 wakes it (CONTINUE from now on): 256 frames since its last call");
    assert.equal(steady(), 128 / 65536);
    plugin.reset();
    assert.equal(steady(63), 0, "the first call after the reset");
    assert.equal(steady(), 128 / 65536);
    plugin.destroy();
});

test("back from bypass, and after a restart, a sleeping plug-in is processed again", async () => {
    const plugin = await lifecycle();
    const chain = new Chain(new Scheduler(EventQueue.create()), 48000);
    const slot = { id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false };
    chain.add(slot);
    const render = () => {
        chain.render(0, 128, [], [[new Float32Array(128)], [new Float32Array(128)]]);
        return plugin.audio?.skipped;
    };
    // The runner gives it main-thread time after each block, so its start-up wake comes at once.
    assert.deepEqual([render(), render(), render()], [false, false, true]);
    chain.runner.setEnabled(slot, false);
    render();
    chain.runner.setEnabled(slot, true);
    assert.deepEqual([render(), render()], [false, true], "reset on the way back: one block, then its SLEEP");
    plugin.requests.add("restart");
    plugin.idle();
    assert.equal(render(), false, "processing starts afresh after a restart");
    assert.ok([render(), render()].includes(true), "and it sleeps again");
    plugin.destroy();
});

test("two threads: request_process and params.request_flush wait for the audio side, not the main side", () => {
    const control = Control.create();
    control.request("process");
    control.request("callback");
    assert.deepEqual(control.take(), ["callback"]);
    assert.deepEqual([control.takeAudio("params-flush"), control.takeAudio("process")], [false, true]);
    assert.equal(control.takeAudio("process"), false, "taken once");
});
