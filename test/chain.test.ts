import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { OutputList } from "../src/plugin/clap-host-callbacks.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import type { Event } from "../src/plugin/plugin-types.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import type { Processor } from "../src/worklet/plugin-runner.ts";
import { fetchFixture, HIVE } from "./fetch-fixture.ts";

const load = async (name: string) => {
    const bytes =
        name === "Hive"
            ? await fetchFixture(HIVE)
            : readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url));
    const bundle = await openBundle(bytes);
    const instance = Instance.create(bundle, { log: () => undefined });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    plugin.activate(48000, 128);
    return plugin;
};

let nextId = 1;
const chainOf = async (...names: string[]) => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const ids: number[] = [];
    for (const name of names) {
        const plugin = await load(name);
        const id = nextId++;
        ids.push(id);
        chain.add({ id, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    }
    return { chain, queue, ids };
};

const stereo = () => [[new Float32Array(128), new Float32Array(128)]];
const sine = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10));

test("a queued note sounds from its audio frame, blocks later", async () => {
    const { chain, queue } = await chainOf("PICOH-101");
    queue.push(300, { type: "note-on", key: 60, velocity: 0.8 });
    const blocks = [0, 128, 256].map((start) => {
        const out = stereo();
        chain.render(start, 128, [], out);
        return out[0]?.[0] ?? new Float32Array();
    });
    assert.ok(blocks[0]?.every((v) => v === 0) && blocks[1]?.every((v) => v === 0));
    assert.equal(
        blocks[2]?.findIndex((v) => v !== 0),
        300 - 256,
    );
});

test("audio passes through effects in order; a bypassed one passes it untouched", async () => {
    const { chain, queue, ids } = await chainOf("HeadlessGain", "HeadlessGain");
    for (const id of ids) queue.push(0, { type: "param", id: 0, value: -6.020599913 }, id);
    const out = stereo();
    chain.render(0, 128, [[sine, sine]], out);
    assert.ok(
        out[0]?.[0]?.every((v, i) => Math.abs(v - 0.25 * (sine[i] ?? 0)) < 1e-6),
        "half of half",
    );
    const second = chain.slots[1];
    if (second) second.enabled = false;
    chain.render(128, 128, [[sine, sine]], out);
    assert.ok(
        out[0]?.[0]?.every((v, i) => Math.abs(v - 0.5 * (sine[i] ?? 0)) < 1e-6),
        "the second bypassed",
    );
});

test("a parameter change goes only to the plug-in it's addressed to", async () => {
    const { chain, queue, ids } = await chainOf("HeadlessGain", "HeadlessGain");
    queue.push(0, { type: "param", id: 0, value: -6.020599913 }, ids[1]);
    const out = stereo();
    chain.render(0, 128, [[sine, sine]], out);
    assert.ok(out[0]?.[0]?.every((v, i) => Math.abs(v - 0.5 * (sine[i] ?? 0)) < 1e-6));
});

test("a sequencer's notes play the synth after it, on their frames, following the tempo", async () => {
    const play = async (tempo: number, blocks: number) => {
        const { chain } = await chainOf("Hive", "PICOH-101");
        chain.transport.tempo = tempo;
        const synth = chain.slots[1];
        assert.ok(synth);
        const onsets: number[] = [];
        let block = 0;
        const process = synth.processor.process.bind(synth.processor);
        synth.processor = {
            ...synth.processor,
            output: synth.processor.output,
            process: (frames, events, inputs, count, transport) => {
                for (let i = 0; i < count; i++) {
                    const e = events[i];
                    if (e?.type === "note-on") onsets.push(block * 128 + e.at);
                }
                return process(frames, events, inputs, count, transport);
            },
        };
        let peak = 0;
        for (block = 0; block < blocks; block++) {
            const out = stereo();
            chain.render(block * 128, 128, [], out);
            for (const v of out[0]?.[0] ?? []) peak = Math.max(peak, Math.abs(v));
        }
        return { onsets, peak };
    };
    const fast = await play(120, 400);
    assert.deepEqual(fast.onsets.slice(0, 5), [0, 18000, 24000, 24000, 30000], "Hive's first pattern at 120 BPM");
    assert.ok(fast.peak > 0.1, "and the synth plays them");
    const slow = await play(60, 800);
    assert.deepEqual(
        slow.onsets,
        fast.onsets.map((at) => at * 2),
        "at half the tempo, every note twice as late",
    );
});

test("a plug-in's own parameter changes are reported; notes leaving the chain go out", async () => {
    const { chain } = await chainOf("Hive");
    const reported: number[] = [];
    const out: number[][] = [];
    const hive = chain.slots[0];
    assert.ok(hive);
    const process = hive.processor.process.bind(hive.processor);
    hive.processor = {
        ...hive.processor,
        output: hive.processor.output,
        process: (frames, events, inputs, count, transport) => {
            const result = process(frames, events, inputs, count, transport);
            hive.processor.output.pushParam(5, 6, 42);
            return result;
        },
    };
    chain.onParams = (id, list) => {
        for (let i = 0; i < list.count; i++) {
            const e = list.events[i];
            if (e?.type === "param") reported.push(id, e.id, e.value);
        }
    };
    chain.onNotesOut = (start, notes, count) => {
        for (let i = 0; i < count; i++) out.push([start + (notes[i]?.at ?? 0)]);
    };
    chain.render(0, 128, [], stereo());
    assert.deepEqual(reported, [hive.id, 6, 42]);
    assert.deepEqual(out, [[0]], "Hive's first note leaves the chain at frame 0");
});

test("a plug-in that traps goes silent; the rest of the chain plays on", async () => {
    const { chain, queue, ids } = await chainOf("HeadlessGain", "HeadlessGain");
    const failures: number[] = [];
    chain.onFailure = (id) => failures.push(id);
    const first = chain.slots[0];
    if (first)
        first.processor = {
            ...first.processor,
            process: () => {
                throw new Error("trap");
            },
            output: first.processor.output,
        };
    queue.push(0, { type: "param", id: 0, value: -6.020599913 }, ids[1]);
    const out = stereo();
    chain.render(0, 128, [[sine, sine]], out);
    assert.deepEqual(failures, [ids[0]]);
    assert.ok(out[0]?.[0]?.every((v, i) => Math.abs(v - 0.5 * (sine[i] ?? 0)) < 1e-6));
});

// A stand-in plug-in that records what reaches it, by block, and passes notes on as a MIDI-through would.
function recorder() {
    const seen: string[][] = [];
    const flushed: string[][] = [];
    const describe = (events: readonly Event[], count: number) =>
        events
            .slice(0, count)
            .map((e) => (e.type === "note-on" || e.type === "note-off" ? `${e.type} ${e.key}` : `${e.type}`));
    const output = new OutputList();
    const processor: Processor = {
        output,
        process(_frames, events, inputs, count) {
            seen.push(describe(events, count));
            output.count = 0;
            for (let i = 0; i < count; i++) {
                const e = events[i];
                if (e?.type === "note-on" || e?.type === "note-off")
                    output.push(e.at, e.type, e.key, e.velocity, e.channel ?? 0);
            }
            return inputs;
        },
        flush(events, count) {
            flushed.push(describe(events, count));
            output.count = 0;
        },
    };
    return { processor, seen, flushed };
}

const slotOf = (id: number, processor: Processor) => ({
    id,
    processor,
    ports: { inputs: [2], outputs: [2] },
    enabled: true,
    failed: false,
});

test("bypassing, moving or removing a plug-in lets go of the notes it and those after it hold", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const a = recorder();
    const b = recorder();
    chain.add(slotOf(1, a.processor));
    chain.add(slotOf(2, b.processor));
    queue.push(0, { type: "note-on", key: 60, velocity: 1 });
    chain.render(0, 128, stereo(), stereo());
    assert.deepEqual(b.seen.at(-1), ["note-on 60"], "the note passes through the first to the second");

    chain.setEnabled(1, false);
    chain.render(128, 128, stereo(), stereo());
    assert.deepEqual(a.seen.at(-1), ["note-off 60"], "the bypassed plug-in gets one last block, to let go");
    assert.deepEqual(b.seen.at(-1), ["note-off 60"], "and the plug-in after it lets go too");

    chain.render(256, 128, stereo(), stereo());
    assert.deepEqual(b.seen.at(-1), [], "once");

    chain.setEnabled(1, true);
    queue.push(384, { type: "note-on", key: 62, velocity: 1 });
    chain.render(384, 128, stereo(), stereo());
    chain.move(2, 0);
    chain.render(512, 128, stereo(), stereo());
    assert.deepEqual(b.seen.at(-1), ["note-off 62"], "moved: it lets go");
    // Its own release, and the one before it passing on its release: a repeated note-off does nothing.
    assert.ok(
        a.seen.at(-1)?.every((e) => e === "note-off 62"),
        "and so does the one now after it",
    );
    queue.push(640, { type: "note-on", key: 64, velocity: 1 });
    chain.render(640, 128, stereo(), stereo());
    chain.remove(2);
    chain.render(768, 128, stereo(), stereo());
    assert.deepEqual(a.seen.at(-1), ["note-off 64"], "removed before it: it lets go");
});

test("a bypassed plug-in gets its parameter changes by flush, not lost", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const a = recorder();
    chain.add(slotOf(5, a.processor));
    chain.setEnabled(5, false);
    queue.push(0, { type: "param", id: 3, value: 0.5 }, 5);
    chain.render(0, 128, stereo(), stereo());
    assert.deepEqual(a.flushed.at(-1), ["param"]);
});

test("past a block's event limit, note-offs still get through", () => {
    const queue = EventQueue.create(2048);
    const chain = new Chain(new Scheduler(queue, 2048), 48000);
    const a = recorder();
    chain.add(slotOf(9, a.processor));
    for (let i = 0; i < 300; i++) queue.push(1, { type: "param", id: i, value: 0 });
    queue.push(2, { type: "note-off", key: 60, velocity: 0 });
    chain.render(0, 128, stereo(), stereo());
    chain.render(128, 128, stereo(), stereo());
    assert.ok(a.seen.flat().includes("note-off 60"), "a burst is split over blocks, never dropped");
});

test("a bypassed plug-in still gets idle time, which answers a stop the main side asks for", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const a = recorder();
    let idles = 0;
    chain.add(slotOf(11, { ...a.processor, idle: () => void idles++ }));
    chain.setEnabled(11, false);
    chain.render(0, 128, stereo(), stereo());
    chain.render(128, 128, stereo(), stereo());
    assert.equal(idles, 2);
});

test("notes leave the chain through a bypassed last plug-in, and are let go when the chain's end changes", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const out: string[] = [];
    chain.onNotesOut = (_start, notes, count) => {
        for (let i = 0; i < count; i++) {
            const e = notes[i];
            if (e?.type === "note-on" || e?.type === "note-off") out.push(`${e.type} ${e.key}`);
        }
    };
    const a = recorder();
    chain.add(slotOf(21, a.processor));
    chain.setEnabled(21, false);
    chain.render(0, 128, stereo(), stereo());
    queue.push(128, { type: "note-on", key: 67, velocity: 1 });
    chain.render(128, 128, stereo(), stereo());
    assert.deepEqual(out, ["note-on 67"], "through the bypassed plug-in");
    chain.add(slotOf(22, recorder().processor));
    chain.render(256, 128, stereo(), stereo());
    assert.deepEqual(out, ["note-on 67", "note-off 67"], "the end changed: let go");
});

test("bypassing fades from the plug-in's sound to the dry sound over one block", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const loud = new Float32Array(128).fill(1);
    const processor: Processor = { output: new OutputList(), process: () => [[loud, loud]] };
    chain.add(slotOf(31, processor));
    const dry = [[new Float32Array(128), new Float32Array(128)]];
    const out = stereo();
    chain.setEnabled(31, false);
    chain.render(0, 128, dry, out);
    const left = out[0]?.[0] ?? new Float32Array();
    assert.equal(left[0], 1);
    assert.ok((left[64] ?? 0) > 0.4 && (left[64] ?? 0) < 0.6);
    assert.ok((left[127] ?? 1) < 0.02);
    chain.render(128, 128, dry, out);
    assert.ok(
        out[0]?.[0]?.every((v) => v === 0),
        "then dry",
    );
});

test("a plug-in's any-key note-off (CLAP's -1) lets go of each note sent out, as real MIDI notes", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    const out: string[] = [];
    chain.onNotesOut = (_start, notes, count) => {
        for (let i = 0; i < count; i++) {
            const e = notes[i];
            if (e?.type === "note-on" || e?.type === "note-off") out.push(`${e.type} ${e.channel} ${e.key}`);
        }
    };
    let allOff = false;
    const output = new OutputList();
    chain.add(
        slotOf(41, {
            output,
            process(_frames, events, inputs, count) {
                output.count = 0;
                for (let i = 0; i < count; i++) {
                    const e = events[i];
                    if (e?.type === "note-on") output.push(e.at, "note-on", e.key, e.velocity, e.channel ?? 0);
                }
                if (allOff) output.push(0, "note-off", -1, 0, -1);
                return inputs;
            },
        }),
    );
    queue.push(0, { type: "note-on", key: 60, velocity: 1 });
    queue.push(0, { type: "note-on", key: 64, velocity: 1, channel: 2 });
    chain.render(0, 128, stereo(), stereo());
    allOff = true;
    chain.render(128, 128, stereo(), stereo());
    assert.deepEqual(out, ["note-on 0 60", "note-on 2 64", "note-off 0 60", "note-off 2 64"]);
});

test("a plug-in brought back from bypass is reset before it plays again", () => {
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    let resets = 0;
    chain.add(slotOf(51, { ...recorder().processor, reset: () => void resets++ }));
    chain.setEnabled(51, false);
    chain.render(0, 128, stereo(), stereo());
    assert.equal(resets, 0);
    chain.setEnabled(51, true);
    chain.render(128, 128, stereo(), stereo());
    chain.render(256, 128, stereo(), stereo());
    assert.equal(resets, 1);
});
