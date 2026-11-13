// Saved audio: every fixture plays the same short script (two notes, a parameter change, a test signal in), and its
// output and the notes it sends out must match what was saved in refs.json. WebAssembly's float arithmetic is the
// same on every machine and the script uses no Math functions, so the match is exact and a checksum is enough;
// peak and RMS are kept to say how far a changed output moved.
// After a change that's meant to alter the sound: `UPDATE_REFS=1 npm run test:refs`, and check the diff.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { CLAP_PARAM_IS_HIDDEN, CLAP_PARAM_IS_READONLY } from "../src/plugin/clap.generated.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, OUTSIDE_FIXTURES } from "./fetch-fixture.ts";

interface Ref {
    sha256: string;
    peak: number;
    rms: number;
    notesOut: number;
}

const file = new URL("fixtures/refs.json", import.meta.url);
const update = process.env.UPDATE_REFS === "1";
const refs: Record<string, Ref> = JSON.parse(readFileSync(file, "utf8"));
const blocks = 200;

// A 480 Hz sawtooth at half scale, from integers only.
const input = Float32Array.from({ length: 128 }, (_, i) => ((i % 100) / 50 - 1) * 0.5);

async function play(bytes: Uint8Array): Promise<Ref> {
    const instance = Instance.create(await openBundle(bytes), { log: () => undefined });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    plugin.activate(48000, 128);
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    const param = plugin.params().find((p) => !(p.flags & (CLAP_PARAM_IS_HIDDEN | CLAP_PARAM_IS_READONLY)));
    queue.push(0, { type: "note-on", key: 60, velocity: 0.8 });
    queue.push(6000, { type: "note-on", key: 64, velocity: 0.6 });
    if (param) queue.push(9600, { type: "param", id: param.id, value: (param.min + param.max) / 2 });
    queue.push(14400, { type: "note-off", key: 60, velocity: 0 });
    queue.push(14400, { type: "note-off", key: 64, velocity: 0 });

    const hash = createHash("sha256");
    let notesOut = 0;
    chain.onNotesOut = (start, notes, count) => {
        for (let i = 0; i < count; i++) {
            const n = notes[i];
            if (!n) continue;
            notesOut++;
            hash.update(`${n.type} ${start + n.at} ${"key" in n ? n.key : ""};`);
        }
    };
    let peak = 0;
    let squares = 0;
    for (let block = 0; block < blocks; block++) {
        const out = [[new Float32Array(128), new Float32Array(128)]];
        chain.render(block * 128, 128, [[input, input]], out);
        for (const channel of out[0] ?? []) {
            hash.update(new Uint8Array(channel.buffer));
            for (const v of channel) {
                peak = Math.max(peak, Math.abs(v));
                squares += v * v;
            }
        }
    }
    plugin.destroy();
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    return { sha256: hash.digest("hex"), peak: round(peak), rms: round(Math.sqrt(squares / (blocks * 256))), notesOut };
}

const local = ["PICOH-101", "Tapa", "HeadlessGain", "HeavyMain"].map((name) => ({
    name,
    bytes: async () => readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url)),
}));
const outside = OUTSIDE_FIXTURES.map((f) => ({ name: f.name, bytes: () => fetchFixture(f) }));

for (const { name, bytes } of [...local, ...outside]) {
    test(`${name} sounds as saved`, async () => {
        const got = await play(await bytes());
        if (update) refs[name] = got;
        const want = refs[name];
        assert.ok(want, `${name} has no saved reference: UPDATE_REFS=1 npm run test:refs`);
        assert.ok(
            got.sha256 === want.sha256,
            `${name} changed: peak ${want.peak} → ${got.peak}, RMS ${want.rms} → ${got.rms}, ` +
                `notes out ${want.notesOut} → ${got.notesOut}. If that's intended: UPDATE_REFS=1 npm run test:refs`,
        );
    });
}

after(() => {
    if (update) writeFileSync(file, `${JSON.stringify(refs, null, 4)}\n`);
});
