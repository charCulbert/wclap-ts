import assert from "node:assert/strict";
import { test } from "node:test";
import {
    CLAP_EVENT_MIDI,
    clap_audio_buffer,
    clap_event_midi,
    clap_gui_resize_hints,
    clap_istream,
    clap_param_info,
    clap_plugin,
    clap_plugin_descriptor,
    clap_plugin_params,
    clap_process,
} from "../src/plugin/clap.generated.ts";
import { asPtr, NULL, type Ptr, Wasm } from "../src/plugin/wasm-struct.ts";

const setup = () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    return new Wasm(memory, table);
};

const writeString = (wasm: Wasm, at: number, s: string) => {
    wasm.bytes.set(new TextEncoder().encode(`${s}\0`), at);
};

test("values of every kind round-trip", () => {
    const wasm = setup();
    const info = wasm.struct(clap_param_info, asPtr(1024));
    info.set("id", 0xfffffffe);
    info.set("min_value", -2.5);
    assert.equal(info.get("id"), 0xfffffffe);
    assert.equal(info.get("min_value"), -2.5);

    const buffer = wasm.struct(clap_audio_buffer, asPtr(4096));
    buffer.set("constant_mask", 2n ** 64n - 1n);
    assert.equal(buffer.get("constant_mask"), 2n ** 64n - 1n);

    const process = wasm.struct(clap_process, asPtr(4200));
    process.set("steady_time", -1n);
    process.set("audio_outputs", buffer.at);
    assert.equal(process.get("steady_time"), -1n);
    assert.equal(process.get("audio_outputs"), 4096);
    for (const n of [0, 2 ** 40 + 7, -(2 ** 33) - 5]) {
        process.set("steady_time", n);
        assert.equal(process.get("steady_time"), BigInt(n), "a number writes the same 64 bits as a bigint");
    }

    const hints = wasm.struct(clap_gui_resize_hints, asPtr(4300));
    hints.set("can_resize_vertically", true);
    assert.equal(hints.get("can_resize_vertically"), true);
    assert.equal(hints.get("can_resize_horizontally"), false);
});

test("strings, nested structs and arrays", () => {
    const wasm = setup();
    const desc = wasm.struct(clap_plugin_descriptor, asPtr(512));
    writeString(wasm, 2048, "com.example.synth");
    desc.set("id", asPtr(2048));
    desc.inner("clap_version").set("minor", 2);
    assert.equal(desc.string("id"), "com.example.synth");
    assert.equal(desc.string("name"), "");
    assert.equal(desc.inner("clap_version").get("minor"), 2);
    assert.equal(wasm.view.getUint32(512 + 4, true), 2);

    const info = wasm.struct(clap_param_info, asPtr(1024));
    writeString(wasm, 1024 + clap_param_info.fields.name.at, "Cutoff");
    assert.equal(info.string("name"), "Cutoff");

    const midi = wasm.struct(clap_event_midi, asPtr(3000));
    midi.inner("header").set("type", CLAP_EVENT_MIDI);
    midi.setItem("data", 0, 0x90);
    midi.setItem("data", 2, 100);
    assert.equal(midi.inner("header").get("type"), CLAP_EVENT_MIDI);
    assert.deepEqual(
        [0, 1, 2].map((i) => midi.item("data", i)),
        [0x90, 0, 100],
    );
    assert.throws(() => midi.item("data", 3), /clap_event_midi.data\[3\] is out of range/);
});

test("calls through the table, both ways", () => {
    const wasm = setup();
    const plugin = wasm.struct(clap_plugin, asPtr(64));
    const seen: unknown[] = [];
    plugin.setFn("activate", (self, rate, min, max) => {
        seen.push(self, rate, min, max);
        return true;
    });
    assert.equal(plugin.has("activate"), true);
    assert.equal(plugin.has("reset"), false);
    assert.equal(plugin.call("activate", plugin.at, 48000, 32, 0xffffffff), true);
    assert.deepEqual(seen, [64, 48000, 32, 0xffffffff]);
    assert.throws(() => plugin.call("reset", plugin.at), /clap_plugin.reset is null/);

    const stream = wasm.struct(clap_istream, asPtr(128));
    stream.setFn("read", (_self, _buffer, size) => -size);
    assert.equal(stream.call("read", stream.at, NULL, 2n ** 40n), -(2n ** 40n));

    const params = wasm.struct(clap_plugin_params, asPtr(160));
    params.setFn("get_value", (_plugin, id, _out) => id === 0xfffffffe);
    assert.equal(params.call("get_value", plugin.at, 0xfffffffe, asPtr(8)), true);
    assert.equal(params.call("get_value", plugin.at, 7, asPtr(8)), false);
});

test("views follow the memory when it grows", () => {
    const wasm = setup();
    assert.equal(wasm.view.byteLength, 65536);
    wasm.memory.grow(1);
    const info = wasm.struct(clap_param_info, asPtr(65536 + 8));
    info.set("max_value", 1.5);
    assert.equal(info.get("max_value"), 1.5);
});

// Checked by tsc only: each line below must be a type error.
export function typeErrors(wasm: Wasm, plugin: Ptr<"clap_plugin">) {
    const p = wasm.struct(clap_plugin, plugin);
    // @ts-expect-error a descriptor pointer is not a process pointer
    wasm.struct(clap_process, p.get("desc"));
    // @ts-expect-error a plain number is not a pointer
    wasm.struct(clap_plugin, 64);
    // @ts-expect-error activate takes four arguments
    p.call("activate", p.at, 48000, 32);
    // @ts-expect-error the sample rate is a number
    p.call("activate", p.at, "48000", 32, 128);
    // @ts-expect-error no such field
    p.get("activated");
    // @ts-expect-error a function pointer is set with setFn
    p.set("init", 3);
    // @ts-expect-error init returns a boolean
    p.setFn("init", () => 1);
    // @ts-expect-error steady_time is a number or bigint, not a string
    wasm.struct(clap_process, asPtr(0)).set("steady_time", "0");
}
