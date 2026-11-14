import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_MAP } from "../src/events/timeline.ts";
import { capMemory } from "../src/page/wclap-host.ts";
import {
    CLAP_CORE_EVENT_SPACE_ID,
    CLAP_EVENT_MIDI,
    CLAP_EVENT_NOTE_ON,
    CLAP_EVENT_PARAM_GESTURE_BEGIN,
    CLAP_EVENT_PARAM_GESTURE_END,
    CLAP_EVENT_PARAM_VALUE,
    CLAP_EVENT_TRANSPORT,
    CLAP_EXT_LATENCY,
    CLAP_EXT_NOTE_NAME,
    CLAP_EXT_PARAMS,
    CLAP_EXT_STATE,
    CLAP_PARAM_CLEAR_ALL,
    CLAP_TRANSPORT_IS_LOOP_ACTIVE,
    CLAP_TRANSPORT_IS_PLAYING,
    clap_event_header,
    clap_event_midi,
    clap_event_note,
    clap_event_param_gesture,
    clap_event_param_value,
    clap_event_transport,
    clap_host,
    clap_host_latency,
    clap_host_note_name,
    clap_host_params,
    clap_host_state,
    clap_output_events,
    clap_process,
} from "../src/plugin/clap.generated.ts";
import { EVENT_SIZE } from "../src/plugin/clap-host-callbacks.ts";
import { PluginAudio } from "../src/plugin/plugin-audio-thread.ts";
import { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { asPtr } from "../src/plugin/wasm-struct.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { TransportClock } from "../src/worklet/transport-clock.ts";
import { fetchFixture, OUTSIDE_FIXTURES } from "./fetch-fixture.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url));
// A bundle from the repo's fixtures, or one fetched (test/fetch-fixture.ts).
const bytes = (name: string) => {
    const outside = OUTSIDE_FIXTURES.find((f) => f.name === name);
    return outside ? fetchFixture(outside) : fixture(name);
};

const start = async (name: string) => {
    const log: string[] = [];
    const instance = Instance.create(await openBundle(await bytes(name)), { log: (t) => log.push(t) });
    const plugin = Plugin.create(instance, instance.plugins()[0]?.id ?? "", (t) => log.push(t));
    plugin.activate(48000, 128);
    return { instance, plugin, log };
};

test("bundles: a shared imported memory, or the module's own", async () => {
    const synth = await openBundle(fixture("PICOH-101"));
    assert.deepEqual(synth.memory, { initial: 2, maximum: 32768, shared: true });
    assert.ok(synth.files.has("page/index.html"));
    assert.ok(!synth.files.has("module.wasm"));
    assert.equal((await openBundle(fixture("HeadlessGain"))).memory, null);
});

test("the factory lists each plug-in", async () => {
    const instance = Instance.create(await openBundle(fixture("PICOH-101")));
    assert.deepEqual(instance.plugins(), [
        {
            id: "com.charlieculbert.picoh-101",
            name: "PICOH-101",
            vendor: "Charlie Culbert",
            version: "1.0.0",
            features: ["instrument", "synthesizer", "mono"],
        },
    ]);
});

test("an instrument starts sounding on the frame of its note", async () => {
    const { plugin } = await start("PICOH-101");
    assert.deepEqual([plugin.ports.inputs, plugin.ports.outputs], [[], [2]]);
    const out = plugin.ports.outputInfo?.[0];
    assert.ok(out?.main && out.channels === 2 && out.name.length > 0, "the main output, named, with its channels");
    for (const at of [0, 37, 127]) {
        const left = plugin.process(128, [{ at, type: "note-on", key: 60, velocity: 0.8 }])[0]?.[0];
        assert.equal(
            left?.findIndex((v) => v !== 0),
            at,
        );
        plugin.process(128, [{ at: 0, type: "note-off", key: 60, velocity: 0 }]);
        for (let i = 0; i < 400; i++) plugin.process(128);
        assert.ok(
            plugin.process(128)[0]?.[0]?.every((v) => v === 0),
            "silent again after the release",
        );
    }
    plugin.destroy();
});

test("an effect applies a parameter change from its frame", async () => {
    const { plugin } = await start("HeadlessGain");
    assert.deepEqual([plugin.ports.inputs, plugin.ports.outputs], [[2], [2]]);
    const sine = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10));
    const [left, right] =
        plugin.process(128, [{ at: 0, type: "param", id: 0, value: -6.020599913 }], [[sine, sine]])[0] ?? [];
    for (const channel of [left, right]) assert.ok(channel?.every((v, i) => Math.abs(v - 0.5 * (sine[i] ?? 0)) < 1e-6));
    plugin.destroy();
});

test("main-thread work waits for idle", async () => {
    const { plugin } = await start("PICOH-101");
    plugin.process(128);
    assert.ok(plugin.requests.has("callback"));
    plugin.idle();
    assert.ok(!plugin.requests.has("callback"));
    plugin.destroy();
});

test("a plug-in's latency, parameter, note-name or state change reaches onChange at idle, and a restart reports latency", async () => {
    const instance = Instance.create(await openBundle(fixture("HeadlessGain")));
    const changes: string[] = [];
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { onChange: (w) => changes.push(w) });
    const setup = main.activate(48000, 128);
    const extension = new Map(setup.extensions);
    const hostAt = asPtr<"clap_host">(0);
    const call = (layout: typeof clap_host_latency | typeof clap_host_note_name, name: string) =>
        instance.wasm.struct(layout, asPtr(extension.get(name) ?? 0)).call("changed", hostAt);
    call(clap_host_latency, CLAP_EXT_LATENCY);
    call(clap_host_note_name, CLAP_EXT_NOTE_NAME);
    instance.wasm
        .struct(clap_host_params, asPtr(extension.get(CLAP_EXT_PARAMS) ?? 0))
        .call("clear", hostAt, 0, CLAP_PARAM_CLEAR_ALL);
    instance.wasm.struct(clap_host_state, asPtr(extension.get(CLAP_EXT_STATE) ?? 0)).call("mark_dirty", hostAt);
    assert.deepEqual(changes, [], "nothing until idle");
    main.idle();
    assert.deepEqual(changes, ["latency", "params", "note-names", "state"]);
    main.restart();
    main.idle();
    assert.deepEqual(changes.slice(4), ["latency"]);
    main.destroy();
});

test("presets: the plug-in's own list, and loading one changes its state", async () => {
    const instance = Instance.create(await openBundle(fixture("Tapa")));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    const presets = main.presets();
    assert.equal(presets.length, 20);
    assert.deepEqual(
        presets.slice(0, 3).map((p) => p.name),
        ["Soft Kick", "Short Kick", "Deep Kick"],
    );
    const snare = presets.find((p) => p.name === "Snare");
    assert.ok(snare);
    const before = main.saveState();
    main.loadPreset(snare);
    assert.notDeepEqual(main.saveState(), before);
    main.destroy();
});

test("values read back after a preset load; an interface sized to fit and served by the plug-in", async () => {
    const instance = Instance.create(await openBundle(fixture("Tapa")));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    const before = new Map(main.paramValues());
    assert.equal(before.size, main.params().length, "a value for every parameter");
    for (const p of main.params()) {
        const v = before.get(p.id) ?? Number.NaN;
        assert.ok(v >= p.min && v <= p.max, `${p.name} within its range`);
    }
    const snare = main.presets().find((p) => p.name === "Snare");
    assert.ok(snare);
    main.loadPreset(snare);
    const after = new Map(main.paramValues());
    assert.ok(
        [...after].some(([id, v]) => before.get(id) !== v),
        "the preset changed some values",
    );
    main.destroy();

    const synth = Instance.create(await openBundle(fixture("PICOH-101")));
    const picoh = PluginMain.create(synth, synth.plugins()[0]?.id ?? "", { log: () => undefined });
    const info = picoh.openInterface();
    assert.ok(info);
    const got = picoh.resizeInterface(info.width / 2, info.height / 2);
    if (info.resizable) assert.ok(got && got.width > 0 && got.height > 0, "a resizable interface takes a size");
    else assert.equal(got, null, "a fixed-size interface refuses");
    const page = picoh.getResource(info.uri);
    assert.ok(page?.mime.startsWith("text/html") && page.bytes.length > 0, "the plug-in serves its own page");
    assert.equal(picoh.getResource("/no-such-file.js"), null);
    picoh.closeInterface();
    picoh.destroy();
});

test("events outside the block, or out of order, are refused", async () => {
    const { plugin } = await start("PICOH-101");
    assert.throws(() => plugin.process(64, [{ at: 64, type: "note-on", key: 60, velocity: 1 }]), /outside the block/);
    assert.throws(() => plugin.process(256), /more than the 128 activated/);
    const late = { at: 10, type: "note-on", key: 60, velocity: 1 } as const;
    assert.throws(() => plugin.process(128, [late, { ...late, at: 5 }]), /not in time order/);
});

test("a plug-in that checks threads runs and stops without complaint", async () => {
    const { plugin, log } = await start("Tapa");
    let peak = 0;
    for (let b = 0; b < 100; b++) {
        const out = plugin.process(128, b === 0 ? [{ at: 0, type: "note-on", key: 60, velocity: 0.9 }] : []);
        for (const v of out[0]?.[0] ?? []) peak = Math.max(peak, Math.abs(v));
        plugin.idle();
    }
    assert.ok(peak > 0.1);
    plugin.destroy();
    assert.deepEqual(
        log.filter((line) => /wrong thread/.test(line)),
        [],
    );
});

test("memory: a shared memory's maximum is capped, never below its initial size", async () => {
    const synth = await openBundle(fixture("PICOH-101"));
    assert.deepEqual(capMemory(synth, 64).memory, { initial: 2, maximum: 1024, shared: true });
    assert.throws(() => capMemory(synth, 0), /maxMemoryMB/, "an initial size above the cap is refused, not raised");
    assert.equal(capMemory(synth, 1 << 20).memory?.maximum, 32768, "never above the module's own maximum");
    const gain = await openBundle(fixture("HeadlessGain"));
    assert.equal(capMemory(gain, 64), gain, "a module with its own memory is left alone");
});

test("a block the plug-in reports as an error (CLAP_PROCESS_ERROR) comes out silent", async () => {
    const { plugin } = await start("process-lifecycle");
    assert.deepEqual(plugin.ports.outputs, [1, 1]);
    // Its first two blocks are markers: 0.1, then 0.2 once woken from the main thread.
    assert.equal(plugin.process(128)[0]?.[0]?.[0], Math.fround(0.1));
    plugin.idle();
    assert.equal(plugin.process(128)[0]?.[0]?.[0], Math.fround(0.2));
    // Key 65 fills both outputs with 9.0 and returns CLAP_PROCESS_ERROR.
    const out = plugin.process(128, [{ at: 0, type: "note-on", key: 65, velocity: 1 }]);
    assert.equal(out.length, 2);
    for (const port of out) assert.ok(port[0]?.every((v) => v === 0));
    plugin.destroy();
});

test("the transport is written into each block: play state, time signature, bar, and positions in fixed point", async () => {
    const instance = Instance.create(await openBundle(fixture("HeadlessGain")));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    const setup = main.activate(48000, 128);
    const audio = new PluginAudio(instance.wasm, setup, main.events, main.output, main.thread);
    const process = instance.wasm.struct(clap_process, asPtr(setup.process));
    const read = instance.wasm.struct(clap_event_transport, asPtr(setup.transport));
    const fixed = (v: number) => BigInt(v * 2 ** 31);

    audio.process(128, [], [], 0, { tempo: 90, playing: false, beats: 13.5, numerator: 3, denominator: 4 });
    assert.equal(process.get("transport"), setup.transport);
    assert.equal(read.get("flags") & CLAP_TRANSPORT_IS_PLAYING, 0, "stopped");
    assert.equal(read.get("tempo"), 90);
    assert.deepEqual([read.get("tsig_num"), read.get("tsig_denom")], [3, 4]);
    assert.equal(read.get("bar_number"), 4, "three beats a bar: beat 13.5 is in bar 4, from 0");
    assert.equal(BigInt(read.get("bar_start")), fixed(12));
    assert.equal(BigInt(read.get("song_pos_beats")), fixed(13.5));
    assert.equal(BigInt(read.get("song_pos_seconds")), fixed(9), "13.5 beats at 90 BPM");

    audio.process(128, [], [], 0, { tempo: 120, playing: true, beats: 7, seconds: 2, numerator: 6, denominator: 8 });
    assert.equal(read.get("flags") & CLAP_TRANSPORT_IS_PLAYING, CLAP_TRANSPORT_IS_PLAYING, "playing");
    assert.equal(read.get("bar_number"), 2, "6/8 is three quarter notes a bar");
    assert.equal(BigInt(read.get("bar_start")), fixed(6));
    assert.equal(BigInt(read.get("song_pos_seconds")), fixed(2), "the seconds given");

    audio.process(128, [], [], 0, { tempo: 120, playing: true, beats: 5 });
    assert.deepEqual(
        [read.get("tsig_num"), read.get("tsig_denom"), read.get("bar_number")],
        [4, 4, 1],
        "4/4 unless set",
    );

    audio.process(128);
    assert.equal(process.get("transport"), 0, "no transport, none passed");
    audio.stop();
    main.destroy();
});

test("a loop wrapping inside a block reaches the plug-in as a transport event on its frame, among the notes", async () => {
    const instance = Instance.create(await openBundle(fixture("HeadlessGain")));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    const setup = main.activate(48000, 128);
    const audio = new PluginAudio(instance.wasm, setup, main.events, main.output, main.thread);
    const process = instance.wasm.struct(clap_process, asPtr(setup.process));
    const clock = new TransportClock(48000);
    // 120 bpm: beat 1 is frame 24000, 64 frames into the block from 23936.
    clock.push({ frame: 0, beats: 0, playing: true, map: DEFAULT_MAP, loop: { startBeat: 0, endBeat: 1 } });
    clock.block(23936, 128);
    const notes = [
        { at: 10, type: "note-on", key: 60, velocity: 1 },
        { at: 64, type: "note-on", key: 62, velocity: 1 },
        { at: 100, type: "note-on", key: 64, velocity: 1 },
    ] as const;
    audio.process(128, notes, [], notes.length, clock.transport);
    const header = (i: number) => instance.wasm.struct(clap_event_header, asPtr(setup.events + i * EVENT_SIZE));
    assert.deepEqual(
        [0, 1, 2, 3].map((i) => [header(i).get("type"), header(i).get("time")]),
        [
            [CLAP_EVENT_NOTE_ON, 10],
            [CLAP_EVENT_TRANSPORT, 64],
            [CLAP_EVENT_NOTE_ON, 64],
            [CLAP_EVENT_NOTE_ON, 100],
        ],
        "in time order, the transport before a note on its frame",
    );
    const wrap = instance.wasm.struct(clap_event_transport, asPtr(setup.events + EVENT_SIZE));
    assert.equal(BigInt(wrap.get("song_pos_beats")), 0n, "back at the loop start");
    assert.equal(wrap.get("flags") & CLAP_TRANSPORT_IS_LOOP_ACTIVE, CLAP_TRANSPORT_IS_LOOP_ACTIVE);
    assert.equal(BigInt(wrap.get("loop_end_beats")), BigInt(2 ** 31));
    const start = instance.wasm.struct(clap_event_transport, asPtr(process.get("transport")));
    assert.ok(BigInt(start.get("song_pos_beats")) > 0n, "the block starts before the wrap");
    audio.stop();
    main.destroy();
});

test("a restart the plug-in asks for on one thread happens at idle, and it plays on after", async () => {
    const instance = Instance.create(await openBundle(fixture("PICOH-101")));
    const changes: string[] = [];
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", {
        log: () => undefined,
        onChange: (w) => changes.push(w),
    });
    const plugin = Plugin.wrap(main);
    plugin.activate(48000, 128);
    plugin.process(128);
    plugin.idle();
    // The plug-in's own clap_host.request_restart: installHost puts the host's functions in the table in order, so
    // request_restart (second) sits 20 slots before clap_host_latency.changed (twenty-second).
    const latency = new Map(main.hostExtensions()).get(CLAP_EXT_LATENCY) ?? 0;
    const changed = instance.wasm.read("u32", latency + clap_host_latency.fields.changed.at) as number;
    const host = instance.allocStruct(clap_host);
    host.setIndex("request_restart", changed - 20);
    host.call("request_restart", host.at);
    assert.ok(plugin.requests.has("restart"));
    plugin.idle();
    assert.ok(!plugin.requests.has("restart"));
    assert.deepEqual(changes, ["latency"], "a restart reports latency");
    const left = plugin.process(128, [{ at: 5, type: "note-on", key: 60, velocity: 0.8 }])[0]?.[0];
    assert.equal(
        left?.findIndex((v) => v !== 0),
        5,
        "processing again",
    );
    plugin.destroy();
});

test("latency and tail: frames, and 0xffffffff for a tail that rings on", async () => {
    const report = async (name: string) => {
        const { plugin } = await start(name);
        const values = [plugin.main.latency(), plugin.main.tail()];
        plugin.destroy();
        return values;
    };
    assert.equal((await report("Tapa"))[0], 24);
    assert.equal((await report("pearls"))[1], 0xffffffff);
    assert.equal((await report("openrb-delay"))[1], 292883);
    assert.deepEqual(await report("HeadlessGain"), [0, 0], "none reported");
});

test("events a plug-in sends out: CLAP and MIDI notes, other MIDI, its own parameter values and gestures; the rest dropped", async () => {
    const instance = Instance.create(await openBundle(fixture("HeadlessGain")));
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", { log: () => undefined });
    const setup = main.activate(48000, 128);
    const process = instance.wasm.struct(clap_process, asPtr(setup.process));
    const list = instance.wasm.struct(clap_output_events, asPtr(process.get("out_events")));
    const at = instance.alloc(64);
    const header = (size: number, time: number, type: number, space = CLAP_CORE_EVENT_SPACE_ID) => {
        instance.wasm.bytes.fill(0, at, at + 64);
        const h = instance.wasm.struct(clap_event_header, asPtr(at));
        h.set("size", size);
        h.set("time", time);
        h.set("space_id", space);
        h.set("type", type);
    };
    const push = () => list.call("try_push", list.at, asPtr(at));
    const midi = (time: number, status: number, key: number, velocity: number) => {
        header(clap_event_midi.size, time, CLAP_EVENT_MIDI);
        instance.wasm.bytes.set([status, key, velocity], at + clap_event_midi.fields.data.at);
        return push();
    };
    main.output.count = 0;
    assert.ok(midi(1, 0x93, 64, 127), "a MIDI note-on, channel 4");
    assert.ok(midi(2, 0x93, 64, 0), "a MIDI note-on at velocity 0");
    assert.ok(midi(3, 0x82, 62, 0), "a MIDI note-off");
    assert.ok(midi(4, 0xb0, 1, 100), "a control change, passed on as MIDI");

    header(clap_event_note.size, 5, CLAP_EVENT_NOTE_ON);
    const note = instance.wasm.struct(clap_event_note, asPtr(at));
    note.set("channel", 1);
    note.set("key", 48);
    note.set("velocity", 0.5);
    assert.ok(push());

    header(clap_event_param_value.size, 6, CLAP_EVENT_PARAM_VALUE);
    const param = instance.wasm.struct(clap_event_param_value, asPtr(at));
    param.set("param_id", 7);
    param.set("value", 0.25);
    assert.ok(push());
    for (const [time, type] of [
        [7, CLAP_EVENT_PARAM_GESTURE_BEGIN],
        [8, CLAP_EVENT_PARAM_GESTURE_END],
    ] as const) {
        header(clap_event_param_gesture.size, time, type);
        instance.wasm.struct(clap_event_param_gesture, asPtr(at)).set("param_id", 7);
        assert.ok(push());
    }
    header(clap_event_note.size, 9, CLAP_EVENT_NOTE_ON, CLAP_CORE_EVENT_SPACE_ID + 1);
    assert.ok(push(), "another event space, accepted");

    const got = main.output.events.slice(0, main.output.count).map((e) => {
        if (e.type === "note-on" || e.type === "note-off") return [e.at, e.type, e.channel, e.key, e.velocity];
        if (e.type === "param") return [e.at, e.type, e.id, e.value];
        if (e.type === "midi") return [e.at, e.type, ...e.data.subarray(e.offset, e.offset + e.size)];
        return [e.at, e.type, "id" in e ? e.id : -1];
    });
    assert.deepEqual(got, [
        [1, "note-on", 3, 64, 1],
        [2, "note-off", 3, 64, 0],
        [3, "note-off", 2, 62, 0],
        [4, "midi", 0xb0, 1, 100],
        [5, "note-on", 1, 48, 0.5],
        [6, "param", 7, 0.25],
        [7, "gesture-begin", 7],
        [8, "gesture-end", 7],
    ]);
    main.destroy();
});

test("an interface with several files: opened in order, files served, messages both ways only while it's open", async () => {
    const instance = Instance.create(await openBundle(await bytes("gui-lifecycle")));
    const replies: number[][] = [];
    const main = PluginMain.create(instance, instance.plugins()[0]?.id ?? "", {
        log: () => undefined,
        onInterfaceMessage: (b) => replies.push([...b]),
    });
    assert.equal(main.sendToInterface(new Uint8Array([1])), false, "refused before it's created");
    const info = main.openInterface();
    assert.deepEqual(info, { uri: "/ui/index.html", width: 400, height: 260, resizable: false });
    const text = (path: string) => {
        const r = main.getResource(path);
        return r && [r.mime, new TextDecoder().decode(r.bytes)];
    };
    assert.equal(text("/ui/index.html")?.[0], "text/html");
    assert.equal(text("/ui/style.css")?.[0], "text/css");
    assert.equal(text("/ui/main.js")?.[0], "text/javascript");
    assert.deepEqual(text("/ui/message.txt"), ["text/plain", "Multi-file resources ready.\n"]);
    // The page sends 1 once its files have loaded; the plug-in answers [1, 1], accepted.
    assert.equal(main.sendToInterface(new Uint8Array([1])), true);
    assert.deepEqual(replies, [[1, 1]]);
    main.closeInterface();
    assert.equal(main.sendToInterface(new Uint8Array([1])), false, "refused once closed");
    assert.deepEqual(replies, [[1, 1]]);
    main.destroy();
});
