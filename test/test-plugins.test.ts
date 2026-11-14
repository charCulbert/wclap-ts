// Our test plug-ins (wclap-test-plugins, fetched), each driven as its README's validation protocol says, checking
// the output the README documents. What wclap-ts can't do yet is marked as not done yet, naming the missing piece.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue, Scheduler, type Timed } from "../src/events/event-queue.ts";
import {
    CLAP_EXT_REMOTE_CONTROLS,
    CLAP_INVALID_ID,
    CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
    CLAP_NOTE_EXPRESSION_TUNING,
} from "../src/plugin/clap.generated.ts";
import { OutputList } from "../src/plugin/clap-host-callbacks.ts";
import { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import type { Change, Event, MainOptions } from "../src/plugin/plugin-types.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import type { Processor } from "../src/worklet/plugin-runner.ts";
import { fetchFixture, TEST_PLUGINS } from "./fetch-fixture.ts";

const load = async (name: string, options: MainOptions = {}) => {
    const fixture = TEST_PLUGINS.find((f) => f.name === name);
    assert.ok(fixture);
    const instance = Instance.create(await openBundle(await fetchFixture(fixture)), { log: () => undefined });
    const id = instance.plugins()[0]?.id ?? "";
    const plugin = Plugin.wrap(PluginMain.create(instance, id, { log: () => undefined, ...options }));
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

const note = (at: number, type: "note-on" | "note-off" | "note-choke", noteId: number, channel: number, key: number) =>
    ({ at, type, key, velocity: 1, channel, noteId }) as Event;
const noteEnds = (plugin: Plugin) =>
    plugin.output.events
        .slice(0, plugin.output.count)
        .flatMap((e) => (e.type === "note-end" ? [[e.noteId, e.port, e.channel, e.key]] : []));

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
    // The README's protocol, its CLAP run (probe prefers CLAP), from frame 100 so it crosses a block boundary. The
    // page addresses each voice by key and channel, as the README does.
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
        [46, { type: "note-on", key: 67, velocity: 1, channel: 2 }],
        [47, { type: "note-off", key: 67, velocity: 0, channel: 2 }],
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
            "46:1",
            "47:-1",
            "48:0",
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

test("probe: params.flush applies Level and its modulation between blocks; both survive a reset", async () => {
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
    assert.deepEqual(runs(plugin.process(16)[0]?.[1] ?? new Float32Array()), ["0:0.75"], "Level and modulation kept");
    plugin.destroy();
});

test("probe: voices addressed by note ID, a choke, and a NOTE_END for each ended voice", async () => {
    const plugin = await load("probe");
    const tuning = (at: number, noteId: number, value: number) =>
        ({
            at,
            type: "expression",
            expression: CLAP_NOTE_EXPRESSION_TUNING,
            key: -1,
            noteId,
            value,
        }) as Event;
    const out = plugin.process(64, [
        note(4, "note-on", 7, 0, 60),
        note(16, "note-on", 8, 0, 62),
        { at: 20, type: "param-mod", id: 1, value: 0.5, noteId: 7 },
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

test("note-ids: the README's protocol, note IDs through to NOTE_END", async () => {
    const plugin = await load("note-ids");
    const [left, right] =
        plugin.process(32, [
            note(2, "note-on", 0, 0, 60),
            note(4, "note-on", 100, 0, 60),
            note(6, "note-on", 200, 1, 62),
            note(8, "note-on", -1, 0, 64), // no note ID: ended by the full wildcard at 22
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
        "8:-1",
        "9:0",
        "18:301",
        "19:0",
    ]);
    assert.deepEqual(runs(right ?? new Float32Array()), [
        "0:0",
        "10:101",
        "11:0",
        "16:201",
        "17:0",
        "20:302",
        "21:0",
        "22:-1",
        "23:0",
    ]);
    assert.deepEqual(noteEnds(plugin), [
        [100, 0, 0, 60],
        [200, 0, 1, 62],
        [0, 0, 0, 60],
        [300, 0, 0, 60],
        [-1, 0, 0, 64],
    ]);
    plugin.destroy();
});

// Through a chain, as the page plays: wclap-ts gives each note-on its own ID and sends it again on the note-off.
const noteIdsChain = async () => {
    const plugin = await load("note-ids");
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    chain.add({ id: 1, processor: plugin, ports: plugin.ports, enabled: true, failed: false });
    const render = () => {
        const out = [[new Float32Array(128), new Float32Array(128)]];
        chain.render(0, 128, [], out);
        return out[0]?.map(runs);
    };
    return { plugin, queue, render };
};

test("note IDs: overlapping notes on one key end oldest first, and a choke ends what's left of the key", async () => {
    const { plugin, queue, render } = await noteIdsChain();
    const on = (frame: number, key: number, channel = 0) =>
        queue.push(frame, { type: "note-on", key, velocity: 1, channel });
    const off = (frame: number, key: number, channel = 0) =>
        queue.push(frame, { type: "note-off", key, velocity: 0, channel });
    on(2, 60);
    on(4, 60);
    on(6, 62, 1);
    off(10, 60);
    off(12, 60);
    on(14, 60);
    queue.push(16, { type: "note-choke", key: 60, velocity: 0, channel: 0 });
    off(18, 62, 1);
    off(20, 60); // nothing left on key 60: no ID to give it
    const [left, right] = render() ?? [];
    // IDs from 0, in the order the notes start; each shows as ID + 1.
    assert.deepEqual(left, ["0:0", "2:1", "3:0", "4:2", "5:0", "6:3", "7:0", "14:4", "15:0"]);
    assert.deepEqual(right, ["0:0", "10:1", "11:0", "12:2", "13:0", "16:4", "17:0", "18:3", "19:0"]);
    assert.deepEqual(noteEnds(plugin), [
        [0, 0, 0, 60],
        [1, 0, 0, 60],
        [3, 0, 0, 60],
        [2, 0, 1, 62],
    ]);
    plugin.destroy();
});

test("note IDs: a plug-in's notes reach the next plug-in in the chain with the IDs it gave them", async () => {
    const receiver = await load("note-ids");
    const output = new OutputList();
    // A stand-in note effect that renumbers each note as 1000 + its key.
    const sender: Processor = {
        output,
        process(_frames, events, inputs, count) {
            output.count = 0;
            for (let i = 0; i < count; i++) {
                const e = events[i];
                if (e?.type === "note-on" || e?.type === "note-off")
                    output.push(e.at, e.type, e.key, e.velocity, e.channel ?? 0, 1000 + e.key);
            }
            return inputs;
        },
    };
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    chain.add({ id: 1, processor: sender, ports: { inputs: [], outputs: [] }, enabled: true, failed: false });
    chain.add({ id: 2, processor: receiver, ports: receiver.ports, enabled: true, failed: false });
    queue.push(3, { type: "note-on", key: 60, velocity: 1, channel: 0 });
    queue.push(9, { type: "note-off", key: 60, velocity: 0, channel: 0 });
    const out = [[new Float32Array(128), new Float32Array(128)]];
    chain.render(0, 128, [], out);
    assert.deepEqual(out[0]?.map(runs), [
        ["0:0", "3:1061", "4:0"],
        ["0:0", "9:1061", "10:0"],
    ]);
    receiver.destroy();
});

// process-lifecycle: output 0 a marker for each real process call, output 1 how far steady_time moved since the
// previous call, / 65536 (0 on the first). Its README's render: 41 blocks of 128 frames, main-thread callbacks between
// them, a note-on at each frame below. It prefers MIDI, so wclap-ts sends MIDI note-ons; the README's CLAP run sends
// the same notes as CLAP note-ons, which must give the same output, and a NOTE_END for each.

const LIFECYCLE_KEYS = new Map([
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

const lifecycle = async (dialect = CLAP_NOTE_DIALECT_MIDI) => {
    const plugin = await load("process-lifecycle");
    assert.deepEqual(plugin.ports.outputs, [1, 1]);
    const setup = plugin.audio?.setup;
    assert.ok(setup);
    assert.equal(setup.dialect, CLAP_NOTE_DIALECT_MIDI, "the dialect it prefers");
    assert.ok(setup.dialects & dialect);
    setup.dialect = dialect;
    const blocks = new Map<
        number,
        { marker: Float32Array; steady: Float32Array; tail: number; skipped: boolean; ends: number[][] }
    >();
    for (let start = 0; start < 5248; start += 128) {
        const key = LIFECYCLE_KEYS.get(start);
        const out = plugin.process(128, key ? [{ at: 0, type: "note-on", key, velocity: 1 }] : []);
        const copy = (port: number) => Float32Array.from(out[port]?.[0] ?? []);
        const skipped = plugin.audio?.skipped ?? false;
        const ends = noteEnds(plugin);
        blocks.set(start, { marker: copy(0), steady: copy(1), tail: plugin.main.tail(), skipped, ends });
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

// Each processed block's markers: [start, output 0, output 1 in frames]. wclap-ts's steady_time keeps counting while
// it skips a sleeping plug-in, so the advance after a gap is the whole gap: 896 frames at 1024 and 2048, not 128.
const LIFECYCLE = [
    [0, 0.1, 0], // the first call
    [128, 0.2, 128], // woken once by its request_callback round trip
    [1024, 0.5, 896], // since the 0.2 block, skipped blocks included
    [1152, 0, 128],
    [2048, 0.3, 896],
    [2176, 0.3, 128],
    [2304, 0.3, 128], // the entry block and the 256-sample tail
    [3072, 0.6, 768],
    [3200, 0.6, 128],
    [3328, 0.6, 128],
    [3456, 0.6, 128], // past 256 samples
    [3584, 0, 128], // key 62's own block is processed, and returns SLEEP
    [4096, 0.4, 512],
    [4224, 0, 0], // the quiet block, quiet on both outputs
    [4608, 0.5, 384], // since the quiet block
    [4736, 0, 128],
    [5120, 0, 0], // the 9.0 error block cleared
] as const;

for (const [name, dialect] of [
    ["MIDI", CLAP_NOTE_DIALECT_MIDI],
    ["CLAP", CLAP_NOTE_DIALECT_CLAP],
] as const) {
    test(`process-lifecycle (${name} notes): each woken block's marker and steady time advance, its tails, and no poison`, async () => {
        const block = await lifecycle(dialect);
        for (const [start, marker, advance] of LIFECYCLE) {
            const b = block(start);
            assert.equal(b.skipped, false, `${start} processed`);
            assert.deepEqual(
                [constant(b.marker), constant(b.steady)],
                [Math.fround(marker), advance / 65536],
                `${start}`,
            );
        }
        assert.equal(block(2048).tail, 256);
        assert.ok(block(3072).tail >= 0x7fffffff, "an infinite tail");
        assert.equal(block(3584).tail, 0, "back to none");
        // A CLAP note-on gets a NOTE_END on its own frame, since the plug-in plays no notes; a MIDI one gets none.
        for (const [start, key] of LIFECYCLE_KEYS)
            assert.deepEqual(block(start).ends, name === "CLAP" ? [[-1, 0, 0, key]] : [], `${start}`);
    });
}

test("process-lifecycle: blocks while it sleeps and after its finite tail are skipped and silent", async () => {
    const block = await lifecycle();
    const awake = new Set<number>(LIFECYCLE.map(([start]) => start));
    for (let start = 0; start < 5248; start += 128) {
        const b = block(start);
        assert.equal(b.skipped, !awake.has(start), `${start}`);
        if (b.skipped) assert.deepEqual([constant(b.marker), constant(b.steady)], [0, 0], `${start} silent`);
    }
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

// The value of each channel of each output port, for plug-ins that hold one value across a block.
const held = (out: Float32Array[][]) => out.map((port) => port.map(constant));
const programChange = (at: number, program: number): Event => ({
    at,
    type: "midi",
    data: Uint8Array.of(0xc0, program),
    offset: 0,
    size: 2,
});

// render: every sample is the render mode plus one, 1 for realtime, 2 for offline. The browser test renders it on an
// OfflineAudioContext, which is where wclap-ts asks for offline mode.

test("render: realtime unless the host renders offline, which it says before the first block", async () => {
    const realtime = await load("render");
    assert.deepEqual(realtime.ports.outputs, [1]);
    assert.deepEqual(held(realtime.process(128)), [[1]]);
    realtime.destroy();
    const offline = await load("render", { offline: true });
    assert.deepEqual(held(offline.process(128)), [[2]], "offline from the first frame");
    offline.destroy();
});

// note-name: left the kit, right how many times the host has read the names.

test("note-name: the names, read again when the plug-in says they changed after a program change", async () => {
    const changes: Change[] = [];
    const plugin = await load("note-name", { onChange: (what) => changes.push(what) });
    const names = () => plugin.main.noteNames().map((n) => [n.key, n.name, n.port, n.channel]);
    const kit = (snare: string) => [
        [36, "Kick", 0, -1],
        [38, snare, 0, -1],
        [42, "Closed hi-hat", 0, -1],
        [46, "Open hi-hat", 0, -1],
        [-1, "Any key", 0, -1],
    ];
    assert.deepEqual(names(), kit("Snare"));
    const [left, right] = plugin.process(16, [programChange(8, 1)])[0] ?? [];
    assert.deepEqual(runs(left ?? new Float32Array()), ["0:0", "8:1"]);
    assert.deepEqual(runs(right ?? new Float32Array()), ["0:1"], "one read");
    plugin.idle();
    assert.deepEqual(changes, ["note-names"], "note_name.changed reaches the page as a change, once");
    assert.deepEqual(names(), kit("Rim"));
    assert.deepEqual(held(plugin.process(16)), [[1, 2]]);
    plugin.process(16, [programChange(0, 0)]);
    plugin.idle();
    assert.deepEqual(changes, ["note-names", "note-names"]);
    assert.deepEqual(names(), kit("Snare"));
    plugin.destroy();
});

// remote-controls: left the parameter ID + 1 of the last value set, right how many times the host has read the pages.

test("remote-controls: two pages; a control sets the parameter its page names, also after the layout changes", async () => {
    const plugin = await load("remote-controls");
    assert.deepEqual(
        plugin.params().map((p) => [p.id, p.name]),
        [
            [0, "A"],
            [1, "B"],
            [2, "C"],
            [3, "D"],
        ],
    );
    const none = CLAP_INVALID_ID;
    // Each read of the pages; control 1 of Main, turned, sets the parameter in that slot of the pages last read.
    let pages = plugin.main.remoteControls();
    const turn = (at: number): Event => ({ at, type: "param", id: pages[0]?.params[1] ?? -1, value: 1 });
    assert.deepEqual(
        pages.map((p) => [p.section, p.id, p.name, p.forPreset, p.params]),
        [
            ["Controls", 1, "Main", false, [0, 1, 2, 3, none, none, none, none]],
            ["Controls", 2, "Preset", true, [2, 3, none, none, none, none, none, none]],
        ],
    );
    assert.deepEqual(runs(plugin.process(16, [turn(4)])[0]?.[0] ?? new Float32Array()), ["0:0", "4:2"]);
    plugin.process(16, [programChange(0, 1)]);
    plugin.idle();
    pages = plugin.main.remoteControls();
    assert.deepEqual(pages[0]?.params, [3, 2, 1, 0, none, none, none, none]);
    const [left, right] = plugin.process(16, [turn(4)])[0] ?? [];
    assert.deepEqual(runs(left ?? new Float32Array()), ["0:2", "4:3"], "now parameter C");
    assert.deepEqual(runs(right ?? new Float32Array()), ["0:2"], "one read of the pages each time");
    plugin.destroy();
});

test("remote-controls: a layout change reaches the page through remote_controls.changed and suggest_page", {
    todo: "wclap-ts offers no clap.remote-controls host extension, so the plug-in can't say its pages changed or suggest one (plan: Small gaps, as fixtures need them)",
}, async () => {
    const changes: Change[] = [];
    const plugin = await load("remote-controls", { onChange: (what) => changes.push(what) });
    assert.ok(plugin.main.hostExtensions().some(([name]) => name === CLAP_EXT_REMOTE_CONTROLS));
    plugin.process(16, [programChange(0, 1)]);
    plugin.idle();
    assert.equal(changes.length, 1);
    plugin.destroy();
});

// state-context: left the context the loaded state was saved for, right the context it was loaded with; -1 before any
// load, 0 for state.save and state.load, which have none.

test("state-context: nothing loaded yet, then state.save and state.load round-trip with no context", async () => {
    const plugin = await load("state-context");
    assert.deepEqual(held(plugin.process(16)), [[-1, -1]]);
    plugin.loadState(plugin.saveState());
    assert.deepEqual(held(plugin.process(16)), [[0, 0]]);
    plugin.destroy();
});

test("state-context: a preset, a duplicate and a project are saved and loaded with their own context", async () => {
    const plugin = await load("state-context");
    for (const [context, n] of [
        ["preset", 1],
        ["duplicate", 2],
        ["project", 3],
    ] as const) {
        plugin.loadState(plugin.saveState(context), context);
        assert.deepEqual(held(plugin.process(16)), [[n, n]], context);
    }
    plugin.loadState(plugin.saveState("preset"), "project");
    assert.deepEqual(held(plugin.process(16)), [[1, 3]], "saved as a preset, loaded into a project");
    plugin.destroy();
});

// param-indication: output 0 the mapping and its colour, output 1 the automation state and its colour, -1 until the
// host says.

test("param-indication: two stereo outputs, every channel -1 until the host indicates", async () => {
    const plugin = await load("param-indication");
    assert.deepEqual(plugin.ports.outputs, [2, 2]);
    assert.deepEqual(
        plugin.params().map((p) => [p.id, p.name, p.min, p.max, p.default]),
        [[1, "Target", 0, 1, 0]],
    );
    assert.deepEqual(held(plugin.process(16)), [
        [-1, -1],
        [-1, -1],
    ]);
    plugin.destroy();
});

test("param-indication: mapping a parameter to a control and automating it are indicated, then cleared", {
    todo: "wclap-ts never calls param_indication.set_mapping or set_automation (plan: Small gaps, as fixtures need them)",
}, async () => {
    const plugin = await load("param-indication");
    // Mapped to a control (a MIDI CC, say, through Midi.mapCC on the page), output 0 reads 1 on the left.
    assert.deepEqual(held(plugin.process(16))[0]?.[0], 1);
    plugin.destroy();
});

// voice-info: left the voice count, right how many times the host has read the voice info.

test("voice-info: read once active, and again when the plug-in says it changed", {
    todo: "wclap-ts doesn't read voice_info or offer clap.voice-info to the plug-in (plan: Small gaps, as fixtures need them)",
}, async () => {
    const plugin = await load("voice-info");
    const reads = held(plugin.process(16))[0]?.[1] ?? 0;
    assert.ok(reads >= 1, "read after activating");
    plugin.process(16, [programChange(8, 0)]);
    plugin.idle();
    assert.equal(held(plugin.process(16))[0]?.[1], reads + 1, "read again after voice_info.changed");
    plugin.destroy();
});

// log: left how many messages it has sent, right the severity of the last.

const LOG = [
    "log test 1/7: debug, audio thread",
    "log test 2/7: info, main thread, UTF-8 é✓",
    "log test 3/7: warning, main thread",
    "log test 4/7: error, main thread",
    "log test 5/7: fatal, main thread",
    "log test 6/7: host misbehaving, main thread",
    "log test 7/7: plug-in misbehaving, main thread",
];

test("log: every severity from the audio and main threads, UTF-8 intact, and the plug-in keeps running", async () => {
    const logged: string[] = [];
    const plugin = await load("log", { log: (text) => logged.push(text) });
    assert.deepEqual(held(plugin.process(16)), [[1, 0]]);
    assert.deepEqual(logged, [`[0] ${LOG[0]}`]);
    plugin.idle();
    assert.deepEqual(
        logged,
        LOG.map((text, severity) => `[${severity}] ${text}`),
    );
    assert.deepEqual(held(plugin.process(16)), [[7, 6]], "still processing after FATAL and both MISBEHAVING");
    plugin.destroy();
});

test("log: each message reaches the page with its severity apart from its text", {
    todo: "onLog gets one string with the severity written into it (plan: Small gaps, as fixtures need them)",
}, async () => {
    const logged: unknown[][] = [];
    const plugin = await load("log", { log: (...args: unknown[]) => void logged.push(args) });
    plugin.process(16);
    assert.deepEqual(logged[0], [LOG[0], 0]);
    plugin.destroy();
});

// audio-ports-activation: two mono outputs, 1 and 2 while active, 0 once the host deactivates one.

test("audio-ports-activation: both outputs active from the start", async () => {
    const plugin = await load("audio-ports-activation");
    assert.deepEqual(plugin.ports.outputs, [1, 1]);
    assert.deepEqual(held(plugin.process(16)), [[1], [2]]);
    plugin.destroy();
});

test("audio-ports-activation: an output the page doesn't use is deactivated while the plug-in is inactive", {
    todo: "wclap-ts keeps every port active; no audio_ports_activation calls (plan: Small gaps, as fixtures need them)",
}, async () => {
    const plugin = await load("audio-ports-activation");
    // A page that connects only output 1 would get output 2 deactivated: silence there.
    assert.deepEqual(held(plugin.process(16)), [[1], [0]]);
    plugin.destroy();
});
