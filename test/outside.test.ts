// Every bundle fetched from outside the repo loads, activates and plays: a note and a tone in, finite audio out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, OUTSIDE_FIXTURES } from "./fetch-fixture.ts";

const tone = Float32Array.from({ length: 128 }, (_, i) => 0.5 * Math.sin(i / 10));

for (const fixture of OUTSIDE_FIXTURES) {
    test(`${fixture.name} (${fixture.licence}) loads and plays`, async () => {
        const instance = Instance.create(await openBundle(await fetchFixture(fixture)), { log: () => undefined });
        const descriptors = instance.plugins();
        assert.ok(descriptors.length > 0, "at least one plug-in");
        for (const descriptor of descriptors) {
            const plugin = Plugin.create(instance, descriptor.id, () => undefined);
            plugin.activate(48000, 128);
            const queue = EventQueue.create();
            const chain = new Chain(new Scheduler(queue), 48000);
            chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
            queue.push(0, { type: "note-on", key: 60, velocity: 0.8 });
            queue.push(48000 / 4, { type: "note-off", key: 60, velocity: 0 });
            for (let block = 0; block < 200; block++) {
                const out = [[new Float32Array(128), new Float32Array(128)]];
                chain.render(block * 128, 128, [[tone, tone]], out);
                for (const channel of out[0] ?? [])
                    assert.ok(channel.every(Number.isFinite), `${descriptor.name}: finite output in block ${block}`);
            }
        }
    });
}
