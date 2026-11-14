import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CLAP_EXT_RENDER, CLAP_RENDER_OFFLINE, clap_plugin, clap_plugin_render } from "../src/plugin/clap.generated.ts";
import { PluginAudio } from "../src/plugin/plugin-audio-thread.ts";
import type { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { asPtr } from "../src/plugin/wasm-struct.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { startMain } from "../src/threads/two-threads.ts";

const fixture = (name: string) => openBundle(readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url)));

// No test plug-in has the render extension, so this gives one a render extension that records each set().
function recordRender(main: PluginMain): number[] {
    const wasm = main.instance.wasm;
    const modes: number[] = [];
    const ext = main.instance.allocStruct(clap_plugin_render);
    ext.setFn("has_hard_realtime_requirement", () => false);
    ext.setFn("set", (_plugin, mode) => {
        modes.push(mode);
        return true;
    });
    const index = wasm.read("u32", main.plugin.at + clap_plugin.fields.get_extension.at) as number;
    const original = wasm.table.get(index) as (plugin: number, id: number) => number;
    main.plugin.setFn("get_extension", (plugin, id) =>
        asPtr(wasm.string(id) === CLAP_EXT_RENDER ? ext.at : original(plugin, id)),
    );
    return modes;
}

// HeadlessGain at -6 dB, one block of a sine, started as the page starts a plug-in on either thread.
async function start(offline: boolean, render: boolean) {
    const bundle = await fixture("HeadlessGain");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128, offline };
    const { plugin: main } = startMain(options, { log: () => undefined });
    const modes = render ? recordRender(main) : [];
    const setup = main.activate(48000, 128);
    const audio = new PluginAudio(main.instance.wasm, setup, main.events, main.output, main.thread, () => false);
    const sine = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10));
    const out = audio.process(128, [{ at: 0, type: "param", id: 0, value: -6.020599913 }], [[sine, sine]]);
    const left = Array.from(out[0]?.[0] ?? []);
    audio.stop();
    main.destroy();
    return { modes, left };
}

test("render: offline, a plug-in with the render extension is set to offline before it's activated", async () => {
    assert.deepEqual((await start(true, true)).modes, [CLAP_RENDER_OFFLINE]);
});

test("render: realtime, the plug-in is left in its default (realtime) mode", async () => {
    assert.deepEqual((await start(false, true)).modes, []);
});

test("render: a plug-in without the extension renders offline as it does in realtime", async () => {
    const offline = await start(true, false);
    const realtime = await start(false, false);
    assert.ok(offline.left.some((v) => v !== 0));
    assert.deepEqual(offline.left, realtime.left);
});
