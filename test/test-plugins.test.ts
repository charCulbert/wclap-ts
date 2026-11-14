// Our test plug-ins (wclap-test-plugins, fetched), each driven as its README's validation protocol says, checking
// the output the README documents. What wclap-ts can't do yet is marked as not done yet, naming the missing piece.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue, Scheduler, type Timed } from "../src/events/event-queue.ts";
import { CLAP_NOTE_EXPRESSION_TUNING } from "../src/plugin/clap.generated.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import type { Event } from "../src/plugin/plugin-types.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, TEST_PLUGINS } from "./fetch-fixture.ts";

const load = async (name: string) => {
    const fixture = TEST_PLUGINS.find((f) => f.name === name);
    assert.ok(fixture);
    const instance = Instance.create(await openBundle(await fetchFixture(fixture)), { log: () => undefined });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    plugin.activate(48000, 128);
    return plugin;
};

// Each run of equal samples as "frame:value", so a whole channel compares in one line.
const runs = (samples: Float32Array) => {
    const out: string[] = [];
    samples.forEach((v, i) => {
        if (i === 0 || v !== samples[i - 1]) out.push(`${i}:${v}`);
    });
    return out;
};

// Note IDs, chokes and NOTE_END aren't in wclap-ts's events yet: these carry them for the tests marked not done.
const NO_NOTE_IDS = "wclap-ts sends no note IDs or chokes, and drops NOTE_END (plan: Note IDs and choke)";
const note = (at: number, type: "note-on" | "note-off" | "note-choke", noteId: number, channel: number, key: number) =>
    ({ at, type, key, velocity: 1, channel, noteId }) as unknown as Event;
const noteEnds = (plugin: Plugin) =>
    plugin.output.events
        .slice(0, plugin.output.count)
        .map((e) => e as unknown as Record<string, number | string>)
        .filter((e) => e.type === "note-end")
        .map((e) => [e.noteId, e.port, e.channel, e.key]);

// probe: every event written into the output on its frame. Left: clicks plus each voice's modulation and tuning / 128;
// right: Level plus global modulation.

test("probe: notes, Level, global and per-voice modulation and tuning, each on its frame, through a chain's queue", async () => {
    const plugin = await load("probe");
    assert.deepEqual([plugin.ports.inputs, plugin.ports.outputs], [[2], [2]]);
    assert.deepEqual(
        plugin.params().map((p) => [p.id, p.name, p.min, p.max, p.default]),
        [[1, "Level", 0, 1, 0]],
    );
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    // The README's protocol, from frame 100 so it crosses a block boundary. wclap-ts addresses a voice by key and
    // channel, not note ID: note 7 is key 60, note 8 key 62, both on channel 0. MIDI note 64 on channel 1 arrives as
    // the CLAP note it becomes.
    const at = 100;
    const protocol: [number, Timed][] = [
        [4, { type: "note-on", key: 60, velocity: 1, channel: 0 }],
        [8, { type: "param", id: 1, value: 0.5 }],
        [12, { type: "param-mod", id: 1, value: 0.25 }],
        [16, { type: "note-on", key: 62, velocity: 1, channel: 0 }],
        [20, { type: "param-mod", id: 1, value: 0.5, key: 60, channel: 0 }],
        [24, { type: "expression", expression: CLAP_NOTE_EXPRESSION_TUNING, key: 62, channel: 0, value: 12 }],
        [28, { type: "expression", expression: CLAP_NOTE_EXPRESSION_TUNING, key: -1, value: 32 }],
        [32, { type: "note-off", key: 60, velocity: 0, channel: 0 }],
        [36, { type: "note-off", key: 62, velocity: 0, channel: 0 }],
        [40, { type: "note-on", key: 64, velocity: 100 / 127, channel: 1 }],
        [44, { type: "note-off", key: 64, velocity: 0, channel: 1 }],
        [56, { type: "param-mod", id: 1, value: 0 }],
    ];
    for (const [frame, event] of protocol) queue.push(at + frame, event);
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    for (const start of [0, 128]) {
        const out = [[new Float32Array(128), new Float32Array(128)]];
        chain.render(start, 128, [], out);
        left.set(out[0]?.[0] ?? [], start);
        right.set(out[0]?.[1] ?? [], start);
    }
    const shifted = (rows: string[]) => ["0:0", ...rows.map((r) => r.replace(/^\d+/, (f) => `${at + Number(f)}`))];
    assert.deepEqual(
        runs(left),
        shifted([
            "4:1",
            "5:0",
            "16:1",
            "17:0",
            "20:0.5", // note 7's own modulation, not every voice's
            "24:0.59375", // + note 8's tuning, 12 / 128
            "28:1", // tuning 32 on both voices
            "32:-0.75", // note 7 off: click -1 plus note 8's 0.25
            "33:0.25",
            "36:-1",
            "37:0",
            "40:1",
            "41:0",
            "44:-1",
            "45:0",
        ]),
    );
    assert.deepEqual(
        runs(right),
        shifted(["8:0.5", "12:0.75", "56:0.5"]),
        "per-voice modulation leaves the right alone",
    );
    assert.equal(new Map(plugin.main.paramValues()).get(1), 0.5, "params.get_value reads Level back");
    plugin.destroy();
});

test("probe: params.flush applies Level and its modulation between blocks; a reset clears the modulation", async () => {
    const plugin = await load("probe");
    plugin.flush(
        [
            { at: 0, type: "param", id: 1, value: 0.25 },
            { at: 0, type: "param-mod", id: 1, value: 0.5 },
        ],
        2,
    );
    assert.equal(new Map(plugin.main.paramValues()).get(1), 0.25);
    assert.deepEqual(runs(plugin.process(16)[0]?.[1] ?? new Float32Array()), ["0:0.75"]);
    plugin.reset();
    assert.deepEqual(runs(plugin.process(16)[0]?.[1] ?? new Float32Array()), ["0:0.25"], "Level kept");
    plugin.destroy();
});

test("probe: voices addressed by note ID, a choke, and a NOTE_END for each ended voice", {
    todo: NO_NOTE_IDS,
}, async () => {
    const plugin = await load("probe");
    const tuning = (at: number, noteId: number, value: number) =>
        ({
            at,
            type: "expression",
            expression: CLAP_NOTE_EXPRESSION_TUNING,
            key: -1,
            noteId,
            value,
        }) as unknown as Event;
    const out = plugin.process(64, [
        note(4, "note-on", 7, 0, 60),
        note(16, "note-on", 8, 0, 62),
        { at: 20, type: "param-mod", id: 1, value: 0.5, noteId: 7 } as unknown as Event,
        tuning(24, 8, 12),
        note(32, "note-off", -1, 0, 60),
        note(36, "note-choke", 8, 0, 62),
        { at: 40, type: "note-on", key: 64, velocity: 100 / 127, channel: 1 },
        { at: 44, type: "note-off", key: 64, velocity: 0, channel: 1 },
    ]);
    assert.deepEqual(runs(out[0]?.[0] ?? new Float32Array()), [
        "0:0",
        "4:1",
        "5:0",
        "16:1",
        "17:0",
        "20:0.5",
        "24:0.59375",
        "32:-0.90625",
        "33:0.09375",
        "36:-1",
        "37:0",
        "40:1",
        "41:0",
        "44:-1",
        "45:0",
    ]);
    assert.deepEqual(noteEnds(plugin), [
        [7, 0, 0, 60],
        [8, 0, 0, 62],
        [-1, 0, 1, 64],
    ]);
    plugin.destroy();
});

// note-ids: the left channel shows encode(id) = id + 1 of each note started, the right of each note ended.

test("note-ids: a note-off ends only the voices on its key and channel", async () => {
    const plugin = await load("note-ids");
    assert.deepEqual([plugin.ports.inputs, plugin.ports.outputs], [[], [2]]);
    const right = plugin.process(32, [
        { at: 2, type: "note-on", key: 60, velocity: 1, channel: 0 },
        { at: 4, type: "note-on", key: 60, velocity: 1, channel: 0 },
        { at: 6, type: "note-on", key: 62, velocity: 1, channel: 1 },
        { at: 14, type: "note-off", key: 62, velocity: 0, channel: 0 },
        { at: 20, type: "note-off", key: 60, velocity: 0, channel: 0 },
        { at: 22, type: "note-off", key: -1, velocity: 0, channel: -1 },
    ])[0]?.[1];
    const ended = [...(right ?? [])].flatMap((v, i) => (v !== 0 ? [i] : []));
    assert.deepEqual(ended, [20, 22], "none on channel 0 at frame 14; both key-60 voices at 20; key 62's at 22");
    plugin.destroy();
});

test("note-ids: the README's protocol, note IDs through to NOTE_END", { todo: NO_NOTE_IDS }, async () => {
    const plugin = await load("note-ids");
    const [left, right] =
        plugin.process(32, [
            note(2, "note-on", 0, 0, 60),
            note(4, "note-on", 100, 0, 60),
            note(6, "note-on", 200, 1, 62),
            note(10, "note-off", 100, 0, 60),
            note(12, "note-off", 999, 1, 62),
            note(14, "note-off", -1, 0, 62),
            note(16, "note-choke", 200, 1, 62),
            note(18, "note-on", 300, 0, 60),
            note(20, "note-off", -1, 0, 60),
            note(22, "note-off", -1, -1, -1),
        ])[0] ?? [];
    assert.deepEqual(runs(left ?? new Float32Array()), [
        "0:0",
        "2:1",
        "3:0",
        "4:101",
        "5:0",
        "6:201",
        "7:0",
        "18:301",
        "19:0",
    ]);
    assert.deepEqual(runs(right ?? new Float32Array()), ["0:0", "10:101", "11:0", "16:201", "17:0", "20:302", "21:0"]);
    assert.deepEqual(noteEnds(plugin), [
        [100, 0, 0, 60],
        [200, 0, 1, 62],
        [0, 0, 0, 60],
        [300, 0, 0, 60],
    ]);
    plugin.destroy();
});

// process-lifecycle: output 0 a marker for each real process call, output 1 steady_time / 65536. Its README's render:
// 41 blocks of 128 frames, main-thread callbacks between them, a MIDI note-on (here the CLAP note) at each frame.

const lifecycle = async () => {
    const plugin = await load("process-lifecycle");
    assert.deepEqual(plugin.ports.outputs, [1, 1]);
    const keys = new Map([
        [1024, 63],
        [1152, 62],
        [2048, 60],
        [3072, 64],
        [3584, 62],
        [4096, 61],
        [4608, 63],
        [4736, 62],
        [5120, 65],
    ]);
    const blocks = new Map<number, { marker: Float32Array; steady: Float32Array; tail: number }>();
    for (let start = 0; start < 5248; start += 128) {
        const key = keys.get(start);
        const out = plugin.process(128, key ? [{ at: 0, type: "note-on", key, velocity: 1 }] : []);
        const copy = (port: number) => Float32Array.from(out[port]?.[0] ?? []);
        blocks.set(start, { marker: copy(0), steady: copy(1), tail: plugin.main.tail() });
        plugin.idle();
    }
    plugin.destroy();
    const block = (start: number) => {
        const b = blocks.get(start);
        assert.ok(b);
        return b;
    };
    return block;
};
const constant = (samples: Float32Array) => (samples.every((v) => v === samples[0]) ? samples[0] : Number.NaN);

test("process-lifecycle: each woken block's marker and steady time, the tails it reports, and no poison", async () => {
    const block = await lifecycle();
    const marker = (start: number) => constant(block(start).marker);
    assert.equal(marker(0), Math.fround(0.1));
    assert.equal(marker(128), Math.fround(0.2), "woken once by its request_callback round trip");
    assert.equal(marker(1024), Math.fround(0.5));
    assert.equal(constant(block(1024).steady), 1024 / 65536);
    assert.equal(marker(2048), Math.fround(0.3));
    assert.equal(block(2048).tail, 256);
    for (const start of [3072, 3200, 3328, 3456]) assert.equal(marker(start), Math.fround(0.6), "past 256 samples");
    assert.ok(block(3072).tail >= 0x7fffffff, "an infinite tail");
    assert.equal(marker(4096), Math.fround(0.4));
    assert.deepEqual([marker(4224), constant(block(4224).steady)], [0, 0], "the quiet block, quiet on both outputs");
    assert.equal(marker(4608), Math.fround(0.5));
    assert.equal(constant(block(4608).steady), 4608 / 65536, "steady time advanced");
    assert.deepEqual([marker(5120), constant(block(5120).steady)], [0, 0], "the 9.0 error block cleared");
});

test("process-lifecycle: blocks while it sleeps and after its finite tail are skipped and silent", {
    todo: "wclap-ts processes every block; sleep, tail and skip diagnostics not implemented (plan: Process status)",
}, async () => {
    const block = await lifecycle();
    const skipped = [
        [256, 1024],
        [1152, 2048],
        [2432, 3072], // the 256-sample tail ends at 2431
        [3584, 4096],
        [4352, 4608],
        [4736, 5120],
    ];
    for (const [from = 0, to = 0] of skipped)
        for (let start = from; start < to; start += 128)
            assert.deepEqual([constant(block(start).marker), constant(block(start).steady)], [0, 0], `${start}`);
});

// gui-lifecycle: its interface's open order, files and messages are in plugin.test.ts ("an interface with several
// files"); what's left is its audio.

test("gui-lifecycle: audio passes through unchanged on the main stereo port", async () => {
    const plugin = await load("gui-lifecycle");
    assert.deepEqual([plugin.ports.inputs, plugin.ports.outputs], [[2], [2]]);
    const left = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10));
    const right = Float32Array.from({ length: 128 }, (_, i) => Math.cos(i / 7));
    const out = plugin.process(128, [], [[left, right]])[0];
    assert.deepEqual([...(out?.[0] ?? [])], [...left]);
    assert.deepEqual([...(out?.[1] ?? [])], [...right]);
    plugin.destroy();
});
