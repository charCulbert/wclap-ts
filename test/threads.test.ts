import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CLAP_EXT_LATENCY, CLAP_EXT_STATE, clap_host_latency, clap_host_state } from "../src/plugin/clap.generated.ts";
import { type Behaviour, installHost, OutputList, type Request } from "../src/plugin/clap-host-callbacks.ts";
import { PluginAudio } from "../src/plugin/plugin-audio-thread.ts";
import { PluginMain } from "../src/plugin/plugin-main-thread.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import type { Change, Event } from "../src/plugin/plugin-types.ts";
import { canAttach, Instance } from "../src/plugin/wasm-instance.ts";
import { NULL } from "../src/plugin/wasm-struct.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Control, State } from "../src/threads/control-block.ts";
import { AudioSide, MainThread } from "../src/threads/two-threads.ts";

const transport = { tempo: 120, playing: true, beats: 0 };
const quiet = { log: () => undefined };

test("the handshake: active plays, stopping stops processing, failed stops every call", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main, started } = MainThread.start(options, quiet);
    const audio = new AudioSide(started.audio, () => undefined);
    assert.equal(main.control.state, State.active);
    const note: Event[] = [{ at: 10, type: "note-on", key: 60, velocity: 0.8 }];
    const out = audio.process(128, note, [], 1, transport);
    assert.equal(
        out?.[0]?.[0]?.findIndex((v) => v !== 0),
        10,
    );

    main.control.state = State.stopping;
    assert.equal(audio.process(128, [], [], 0, transport), null, "passes through while stopped");
    assert.equal(main.control.state, State.stopped);

    main.control.state = State.failed;
    assert.throws(() => main.check(), /failed on the audio thread/);
    assert.equal(await main.stop(50), false);
});

test("a restart request on two threads: stop, reactivate on the main side, resume", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main, started } = MainThread.start(options, quiet);
    const audio = new AudioSide(started.audio, () => undefined);
    void main.serve();
    main.control.request("restart");
    // One thread plays both parts here: wait for each side's move, then make the audio side's.
    const state = () => main.control.state;
    const until = async (s: number) => {
        for (let i = 0; i < 100 && state() !== s; i++) await new Promise((r) => setTimeout(r, 5));
        return state();
    };
    assert.equal(await until(State.stopping), State.stopping);
    assert.equal(audio.process(128, [], [], 0, transport), null);
    assert.equal(await until(State.active), State.active);
    const note: Event[] = [{ at: 0, type: "note-on", key: 60, velocity: 0.8 }];
    assert.ok(audio.process(128, note, [], 1, transport), "processing again");
    await main.stop(50);
});

test("an audio port switched on two threads: stop, set_active on the main side, resume", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main, started } = MainThread.start(options, quiet);
    const audio = new AudioSide(started.audio, () => undefined);
    assert.equal(await main.setPortActive(false, 0, false), false, "PICOH-101 has no audio_ports_activation");
    // Our test plug-in that has it isn't built for two threads: stand in for it on the main side.
    const calls: unknown[][] = [];
    Object.defineProperty(main.plugin, "portsActivation", { value: {} });
    main.plugin.setPortActive = (...args) => calls.push([...args, main.control.state]) > 0;
    const done = main.setPortActive(false, 0, false);
    assert.equal(main.control.state, State.stopping);
    assert.equal(audio.process(128, [], [], 0, transport), null, "stops");
    assert.equal(await done, true);
    assert.deepEqual(calls, [[false, 0, false, State.stopped]], "called once the audio side stopped");
    assert.equal(main.control.state, State.active);
    assert.ok(audio.process(128, [], [], 0, transport), "processing again");
    await main.stop(50);
});

test("two threads: the audio side takes the plug-in's request_process and params.request_flush each block", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main, started } = MainThread.start(options, quiet);
    const audio = new AudioSide(started.audio, () => undefined);
    main.control.request("process");
    main.control.request("params-flush");
    assert.deepEqual(main.control.take(), [], "nothing for the main side");
    assert.ok(audio.process(128, [], [], 0, transport));
    assert.deepEqual([main.control.takeAudio("process"), main.control.takeAudio("params-flush")], [false, false]);
    assert.equal(audio.audio.skipped, false);
    assert.equal(await main.stop(50, true), true);
});

test("stop leaves the plug-in alone when the audio side never confirms", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main } = MainThread.start(options, quiet);
    assert.equal(await main.stop(50), false);
    assert.equal(main.control.state, State.stopping);
});

test("a bypassed audio side answers a stop at idle; a throw while processing marks the plug-in failed", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main, started } = MainThread.start(options, quiet);
    const audio = new AudioSide(started.audio, () => undefined);
    audio.process(128, [], [], 0, transport);
    audio.idle();
    assert.equal(main.control.state, State.active, "idle leaves an active plug-in alone");
    main.control.state = State.stopping;
    audio.idle();
    assert.equal(main.control.state, State.stopped);
    assert.ok(!audio.audio.processing, "it stopped processing");

    main.control.state = State.active;
    assert.throws(() => audio.process(256, [], [], 0, transport), /more than the 128 activated/);
    assert.equal(main.control.state, State.failed);
    assert.throws(() => main.check(), /failed on the audio thread/);
});

test("stop when the audio thread is done for good: no handshake, and the plug-in is destroyed", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const { main } = MainThread.start(options, quiet);
    let destroyed = 0;
    const destroy = main.plugin.destroy.bind(main.plugin);
    main.plugin.destroy = () => {
        destroyed++;
        destroy();
    };
    void main.serve();
    const begin = Date.now();
    assert.equal(await main.stop(5000, true), true);
    assert.ok(Date.now() - begin < 1000, "without waiting for the audio side");
    assert.equal(destroyed, 1);
});

test("without Atomics.waitAsync the control block polls: requests and state changes still arrive", async () => {
    const waitAsync = Atomics.waitAsync;
    delete (Atomics as { waitAsync?: unknown }).waitAsync;
    try {
        const control = Control.create();
        const begin = Date.now();
        await control.waitForRequest(5000);
        assert.ok(Date.now() - begin < 1000, "a poll returns soon, whatever the timeout");
        control.request("callback");
        await control.waitForRequest(5000);
        assert.deepEqual(control.take(), ["callback"]);

        setTimeout(() => {
            control.state = State.stopped;
        }, 30);
        assert.equal(await control.untilState(State.stopped, 2000), true);
        assert.equal(await control.untilState(State.active, 50), false, "and times out");
    } finally {
        Atomics.waitAsync = waitAsync;
    }
});

test("two threads: a request the plug-in makes while idle runs is handled once, not again by the serve loop", async () => {
    const bundle = await fixture("PICOH-101");
    const options = { module: bundle.module, memory: bundle.memory, sampleRate: 48000, maxFrames: 128 };
    const changes: Change[] = [];
    let host = (_ext: "latency" | "state") => undefined as unknown;
    const { main } = MainThread.start(options, {
        ...quiet,
        // Asking for something from inside idle, as a plug-in may from on_main_thread or a timer.
        onChange: (what) => {
            changes.push(what);
            if (what === "latency") host("state");
        },
    });
    // The plug-in's own calls to its host: the host's functions by their table index.
    const { instance } = main.plugin;
    const extensions = new Map(main.plugin.hostExtensions());
    host = (ext) => {
        const index = (id: string, at: number) => instance.wasm.read("u32", (extensions.get(id) ?? 0) + at) as number;
        if (ext === "latency") {
            const struct = instance.allocStruct(clap_host_latency);
            struct.setIndex("changed", index(CLAP_EXT_LATENCY, clap_host_latency.fields.changed.at));
            return struct.call("changed", NULL);
        }
        const struct = instance.allocStruct(clap_host_state);
        struct.setIndex("mark_dirty", index(CLAP_EXT_STATE, clap_host_state.fields.mark_dirty.at));
        return struct.call("mark_dirty", NULL);
    };
    host("latency");
    main.plugin.idle();
    main.plugin.idle(); // the serve loop's next pass
    assert.deepEqual(changes, ["latency", "state"]);
    await main.stop(50, true);
});

const fixture = (name: string) => openBundle(readFileSync(new URL(`fixtures/${name}.wclap.tar.gz`, import.meta.url)));

// The main half on one instance, the audio half on a second instance over the same memory.
async function twoInstances(name: string) {
    const bundle = await fixture(name);
    const main = Instance.create(bundle, { log: () => undefined });
    const plugin = PluginMain.create(main, main.plugins()[0]?.id ?? "", { log: () => undefined });
    const thread = main.prepareThread(1);
    const setup = plugin.activate(48000, 128);

    const before = main.wasm.bytes.slice();
    const audio = Instance.attach(bundle.module, main.wasm.memory, thread, { log: () => undefined });
    const after = main.wasm.bytes;
    const changed: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i);
    const requests: Request[] = [];
    const behaviour: Behaviour = {
        events: { at: 0, count: 0 },
        output: new OutputList(),
        extensions: new Map(setup.extensions),
        request: (r) => void requests.push(r),
        log: () => undefined,
        isAudioThread: () => true,
        isMainThread: () => false,
        webviewSend: () => false,
        gui: () => false,
    };
    const slots = installHost(audio.wasm, behaviour);
    const side = new PluginAudio(audio.wasm, setup, behaviour.events, behaviour.output, { audio: true });
    return { main, plugin, thread, setup, audio, slots, side, requests, changed };
}

test("attaching changes no memory outside the new thread's own block", async () => {
    const { thread, changed } = await twoInstances("PICOH-101");
    const outside = changed.filter((at) => at < thread.tls || at >= thread.tls + thread.tlsSize);
    assert.deepEqual(outside, []);
    assert.ok(changed.length > 0);
});

test("only shared-memory modules with the thread exports can take a second instance", async () => {
    assert.equal(canAttach(await fixture("PICOH-101")), true);
    assert.equal(canAttach(await fixture("HeadlessGain")), false);
    assert.equal(canAttach(await fixture("Tapa")), false);
});

test("the second instance gets the same host slots, its own stack and its own thread ID", async () => {
    const { main, thread, setup, audio, slots } = await twoInstances("PICOH-101");
    assert.deepEqual(slots, setup.slots);
    assert.equal(audio.exports.__stack_pointer?.value, thread.stack);
    assert.notEqual(main.exports.__stack_pointer?.value, thread.stack);
    const tids = [];
    for (let at = thread.tls; at < thread.tls + thread.tlsSize; at += 4) tids.push(main.wasm.view.getUint32(at, true));
    assert.ok(tids.includes(2));
    assert.ok(!tids.includes(0x3fffffff));
});

test("the audio instance plays exactly what one instance plays", async () => {
    const { side } = await twoInstances("PICOH-101");
    const bundle = await fixture("PICOH-101");
    const instance = Instance.create(bundle, { log: () => undefined });
    const one = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    one.activate(48000, 128);

    const script: Event[][] = [
        [{ at: 37, type: "note-on", key: 60, velocity: 0.8 }],
        [],
        [],
        [{ at: 5, type: "note-off", key: 60, velocity: 0 }],
    ];
    for (let block = 0; block < 40; block++) {
        const events = script[block] ?? [];
        const a = side.process(128, events)[0]?.[0]?.slice();
        const b = one.process(128, events)[0]?.[0]?.slice();
        assert.deepEqual(a, b, `block ${block}`);
        if (block === 0)
            assert.equal(
                a?.findIndex((v) => v !== 0),
                37,
            );
        one.idle();
    }
});

test("requests made while processing reach the audio side, and the main side serves them", async () => {
    const { plugin, side, requests } = await twoInstances("PICOH-101");
    side.process(128);
    assert.ok(requests.includes("callback"));
    plugin.requests.add("callback");
    plugin.idle();
    assert.ok(!plugin.requests.has("callback"));
    side.stop();
    plugin.destroy();
});
