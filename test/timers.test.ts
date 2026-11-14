import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    CLAP_EXT_TIMER_SUPPORT,
    clap_host_timer_support,
    clap_plugin,
    clap_plugin_timer_support,
} from "../src/plugin/clap.generated.ts";
import { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { asPtr } from "../src/plugin/wasm-struct.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { MainThread } from "../src/threads/two-threads.ts";

const fixture = (name: string) => openBundle(readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url)));

// No test plug-in uses timers, so this gives one a timer-support extension that records each on_timer.
function countTimers(main: PluginMain): number[] {
    const wasm = main.instance.wasm;
    const fired: number[] = [];
    const ext = main.instance.allocStruct(clap_plugin_timer_support);
    ext.setFn("on_timer", (_plugin, id) => void fired.push(id));
    const index = wasm.read("u32", main.plugin.at + clap_plugin.fields.get_extension.at) as number;
    const original = wasm.table.get(index) as (plugin: number, id: number) => number;
    main.plugin.setFn("get_extension", (plugin, id) =>
        asPtr(wasm.string(id) === CLAP_EXT_TIMER_SUPPORT ? ext.at : original(plugin, id)),
    );
    return fired;
}

// The host's timer-support, called as the plug-in calls it: register returns the timer's ID, or -1 if refused.
function timers(main: PluginMain) {
    const at = new Map(main.hostExtensions()).get(CLAP_EXT_TIMER_SUPPORT) ?? 0;
    assert.ok(at, "the host offers timer-support");
    const host = main.instance.wasm.struct(clap_host_timer_support, asPtr(at));
    const out = main.instance.alloc(4);
    return {
        register: (ms: number) =>
            host.call("register_timer", asPtr(0), ms, asPtr(out))
                ? (main.instance.wasm.read("u32", out) as number)
                : -1,
        unregister: (id: number) => host.call("unregister_timer", asPtr(0), id),
    };
}

test("timers on one thread: each fires from idle at its period, until unregistered or the plug-in is destroyed", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const instance = Instance.create(await fixture("HeadlessGain"));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    main.activate(48000, 128);
    const fired = countTimers(main);
    const host = timers(main);
    const fast = host.register(20);
    const slow = host.register(50);
    assert.ok(fast >= 0 && slow >= 0 && fast !== slow);
    // Idle about as often as blocks come round (every 3 ms).
    const run = (ms: number) => {
        for (let i = 1; i <= ms; i++) {
            t.mock.timers.tick(1);
            if (i % 3 === 0) main.idle();
        }
    };
    run(102);
    assert.equal(fired.filter((id) => id === fast).length, 5);
    assert.equal(fired.filter((id) => id === slow).length, 2);
    assert.ok(host.unregister(fast));
    assert.ok(!host.unregister(fast), "already gone");
    fired.length = 0;
    run(102);
    assert.deepEqual(fired, [slow, slow]);
    assert.ok(main.timerDue() <= 50);
    main.destroy();
    assert.equal(main.timerDue(), Number.POSITIVE_INFINITY, "none left after destroy");
});

test("timers on two threads: the main side's Worker fires one at its period, and stops when it's unregistered", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main } = MainThread.start(options, { log: () => undefined });
    const fired = countTimers(main.plugin);
    const host = timers(main.plugin);
    const id = host.register(20);
    void main.serve();
    await new Promise((r) => setTimeout(r, 210));
    const count = fired.length;
    assert.ok(count >= 6 && count <= 11, `${count} in 210 ms`);
    assert.ok(fired.every((f) => f === id));
    host.unregister(id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fired.length, count);
    await main.stop(50, true);
});
