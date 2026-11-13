import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    CLAP_EXT_LATENCY,
    CLAP_EXT_NOTE_NAME,
    CLAP_EXT_PARAMS,
    CLAP_PARAM_CLEAR_ALL,
    clap_host_latency,
    clap_host_note_name,
    clap_host_params,
} from "../src/plugin/clap.generated.ts";
import { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { asPtr } from "../src/plugin/wasm-struct.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url));

const start = async (name: string) => {
    const log: string[] = [];
    const instance = Instance.create(await openBundle(fixture(name)), { log: (t) => log.push(t) });
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

test("a plug-in's latency, parameter or note-name change reaches onChange at idle, and a restart reports latency", async () => {
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
    assert.deepEqual(changes, [], "nothing until idle");
    main.idle();
    assert.deepEqual(changes, ["latency", "params", "note-names"]);
    main.restart();
    main.idle();
    assert.deepEqual(changes.slice(3), ["latency"]);
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
