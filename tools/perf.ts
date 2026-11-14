// How long each fixture takes per block, against a saved baseline: fails if any is more than 20% slower. Times are
// in units of a fixed arithmetic loop timed on the same run, so a faster or slower machine moves them less; still,
// keep the baseline from one machine. `npm run perf`, or `npm run perf -- --update` to save a new baseline.
import { readFileSync, writeFileSync } from "node:fs";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, OUTSIDE_FIXTURES } from "../test/fetch-fixture.ts";

const file = new URL("perf-baseline.json", import.meta.url);
const update = process.argv.includes("--update");
const blocks = 2000;
const input = Float32Array.from({ length: 128 }, (_, i) => ((i % 100) / 50 - 1) * 0.5);

// The fastest of five runs of `blocks` blocks, in microseconds per block.
function time(chain: Chain, queue: EventQueue): number {
    let best = Number.POSITIVE_INFINITY;
    const out = [[new Float32Array(128), new Float32Array(128)]];
    for (let run = 0, frame = 0; run < 5; run++) {
        queue.push(frame, { type: "note-on", key: 60, velocity: 0.8 });
        const begin = performance.now();
        for (let b = 0; b < blocks; b++, frame += 128) chain.render(frame, 128, [[input, input]], out);
        best = Math.min(best, ((performance.now() - begin) * 1000) / blocks);
        queue.push(frame, { type: "note-off", key: 60, velocity: 0 });
    }
    return best;
}

async function measure(bytes?: Uint8Array): Promise<number> {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    if (bytes) {
        const instance = Instance.create(await openBundle(bytes), { log: () => undefined });
        const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
        plugin.activate(48000, 128);
        chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    }
    return time(chain, queue);
}

const local = ["PICOH-101", "Tapa", "HeadlessGain"].map((name) => ({
    name,
    bytes: async () => readFileSync(new URL(`../test/fixtures/${name}.wclap.tar.gz`, import.meta.url)),
}));
const outside = OUTSIDE_FIXTURES.map((f) => ({ name: f.name, bytes: () => fetchFixture(f) }));

// The machine's speed: the fastest of nine runs of a fixed loop, in microseconds.
function calibrate(): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 9; run++) {
        const begin = performance.now();
        let x = 0.5;
        for (let i = 0; i < 1_000_000; i++) x = x * 0.999999 + 0.000001;
        best = Math.min(best, (performance.now() - begin) * 1000 + (x > 2 ? 1 : 0));
    }
    return best;
}

const unit = calibrate();
const now: Record<string, number> = {};
for (const { name, bytes } of [...local, ...outside])
    now[name] = Math.round(((await measure(await bytes())) / unit) * 1e6) / 100; // per 10,000 units

if (update) {
    writeFileSync(file, `${JSON.stringify(now, null, 4)}\n`);
    console.log(`saved ${Object.keys(now).length} fixtures (the unit: ${unit.toFixed(0)} µs)`);
} else {
    const baseline: Record<string, number> = JSON.parse(readFileSync(file, "utf8"));
    let slower = 0;
    console.log(`The unit: ${unit.toFixed(0)} µs. Each fixture's block in units, baseline → now:`);
    for (const [name, value] of Object.entries(now)) {
        const was = baseline[name];
        const flag = was !== undefined && value > was * 1.2 ? "  SLOWER" : "";
        if (flag) slower++;
        console.log(`${name.padEnd(20)} ${String(was ?? "-").padStart(8)} → ${String(value).padStart(8)}${flag}`);
    }
    if (slower) {
        console.error(`${slower} fixture(s) more than 20% slower than the baseline`);
        process.exit(1);
    }
}
