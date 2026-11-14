// Raw MIDI: through the event queue, into a plug-in in the dialect it asks for, out of it, down a chain, and from Web
// MIDI. MidiEcho (test/fixtures/midi-echo) sends every note and MIDI event straight back out and marks each input
// event's frame with its type (left) and flags (right).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EventQueue, MAX_MIDI_BYTES, Scheduler, type Timed } from "../src/events/event-queue.ts";
import { Midi } from "../src/page/midi.ts";
import type { WclapHost } from "../src/page/wclap-host.ts";
import type { WclapPlugin } from "../src/page/wclap-plugin.ts";
import {
    CLAP_EVENT_IS_LIVE,
    CLAP_EVENT_MIDI,
    CLAP_EVENT_MIDI_SYSEX,
    CLAP_EVENT_MIDI2,
    CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
    CLAP_NOTE_DIALECT_MIDI2,
} from "../src/plugin/clap.generated.ts";
import { Plugin } from "../src/plugin/plugin-one-thread.ts";
import type { Event } from "../src/plugin/plugin-types.ts";
import { Instance } from "../src/plugin/wasm-instance.ts";
import { openBundle } from "../src/plugin/wclap-bundle.ts";
import { Chain } from "../src/worklet/chain.ts";
import { fetchFixture, TEST_PLUGINS } from "./fetch-fixture.ts";

const midi = (bytes: number[] | Uint8Array): Timed => {
    const data = Uint8Array.from(bytes);
    return { type: "midi", data, offset: 0, size: data.length };
};
const bytes = (e: Event | undefined) =>
    e?.type === "midi" ? [...e.data.subarray(e.offset, e.offset + e.size)] : undefined;
const sysex = (length: number) =>
    Array.from({ length }, (_, i) => (i === 0 ? 0xf0 : i === length - 1 ? 0xf7 : i % 128));

const echo = async (id = "dev.wclap-ts.midi-echo") => {
    const bundle = await openBundle(readFileSync(new URL("fixtures/MidiEcho.wasm", import.meta.url)));
    const plugin = Plugin.create(Instance.create(bundle, { log: () => undefined }), id, () => undefined);
    plugin.activate(48000, 128);
    return plugin;
};
// Each nonzero frame of a channel as [frame, value].
const marks = (samples: Float32Array | undefined) => [...(samples ?? [])].flatMap((v, i) => (v !== 0 ? [[i, v]] : []));
const out = (plugin: Plugin) =>
    plugin.output.events
        .slice(0, plugin.output.count)
        .map((e) => (e.type === "midi" ? [e.at, ...(bytes(e) ?? [])] : [e.at, e.type, "key" in e ? e.key : 0]));

test("the queue carries raw MIDI and sysex up to MAX_MIDI_BYTES, in time order, with the live flag", () => {
    const queue = EventQueue.create();
    const scheduler = new Scheduler(queue);
    assert.ok(queue.push(10, midi([0xe0, 0, 64]), -1, true));
    assert.ok(queue.push(5, midi(sysex(100)), 3));
    assert.ok(queue.push(7, { type: "note-on", key: 60, velocity: 1, channel: 0 }));
    assert.ok(queue.push(5, midi(sysex(MAX_MIDI_BYTES))));
    assert.equal(queue.push(5, midi(sysex(MAX_MIDI_BYTES + 1))), false, "longer than MAX_MIDI_BYTES");
    assert.equal(queue.push(5, midi([])), false, "empty");
    const { events, count } = scheduler.take(0, 128);
    assert.equal(count, 4);
    assert.deepEqual(bytes(events[0]), sysex(100));
    assert.equal(events[0]?.target, 3);
    assert.equal(events[0]?.live, false);
    assert.deepEqual(bytes(events[1]), sysex(MAX_MIDI_BYTES));
    assert.equal(events[2]?.type, "note-on");
    assert.deepEqual(bytes(events[3]), [0xe0, 0, 64]);
    assert.equal(events[3]?.at, 10);
    assert.equal(events[3]?.live, true);
});

test("a block's sysex past the scheduler's room waits for the next block instead of being dropped", () => {
    const queue = EventQueue.create();
    const scheduler = new Scheduler(queue);
    for (let i = 0; i < 6; i++) queue.push(i, midi(sysex(MAX_MIDI_BYTES)));
    const first = scheduler.take(0, 128).count;
    const second = scheduler.take(128, 128);
    assert.equal(first + second.count, 6);
    assert.ok(first < 6);
    assert.deepEqual(bytes(second.events[second.count - 1]), sysex(MAX_MIDI_BYTES));
    assert.equal(scheduler.dropped, 0);
});

test("the page's side of the queue (drain) gets each message's own bytes", () => {
    const queue = EventQueue.create();
    queue.push(1, midi([0xd0, 99]));
    queue.push(2, midi(sysex(300)));
    const got: number[][] = [];
    queue.drain((frame, e) => void got.push([frame, ...(bytes(e) ?? [])]));
    assert.deepEqual(got, [
        [1, 0xd0, 99],
        [2, ...sysex(300)],
    ]);
});

test("MidiEcho (MIDI dialect): notes arrive as MIDI, pitch bend, aftertouch and sysex as they are, and all come back", async () => {
    const plugin = await echo();
    const events: Event[] = [
        { at: 1, type: "note-on", key: 60, velocity: 1, channel: 2, noteId: 5, live: true },
        { at: 2, type: "midi", data: Uint8Array.of(0xe2, 0x10, 0x50), offset: 0, size: 3 },
        { at: 3, type: "midi", data: Uint8Array.of(0, 0xa2, 60, 70), offset: 1, size: 3 },
        { at: 4, type: "midi", data: Uint8Array.from(sysex(40)), offset: 0, size: 40 },
        { at: 5, type: "midi", data: Uint8Array.of(0xd2, 33), offset: 0, size: 2 },
        { at: 6, type: "note-off", key: 60, velocity: 0, channel: 2, noteId: 5 },
    ];
    const audio = plugin.process(16, events);
    assert.deepEqual(marks(audio[0]?.[0]), [
        [1, CLAP_EVENT_MIDI],
        [2, CLAP_EVENT_MIDI],
        [3, CLAP_EVENT_MIDI],
        [4, CLAP_EVENT_MIDI_SYSEX],
        [5, CLAP_EVENT_MIDI],
        [6, CLAP_EVENT_MIDI],
    ]);
    assert.deepEqual(marks(audio[0]?.[1]), [[1, CLAP_EVENT_IS_LIVE]], "only the live note is marked live");
    assert.deepEqual(out(plugin), [
        [1, "note-on", 60],
        [2, 0xe2, 0x10, 0x50],
        [3, 0xa2, 60, 70],
        [4, ...sysex(40)],
        [5, 0xd2, 33],
        [6, "note-off", 60],
    ]);
    plugin.destroy();
});

test("MidiEcho: a choke or a note-off for any key, which MIDI can't say, goes as a CLAP note", async () => {
    const plugin = await echo();
    const audio = plugin.process(16, [
        { at: 1, type: "note-choke", key: 60, velocity: 0, channel: 0 },
        { at: 2, type: "note-off", key: -1, velocity: 0, channel: -1 },
    ]);
    assert.deepEqual(marks(audio[0]?.[0]), [
        [1, 2], // CLAP_EVENT_NOTE_CHOKE
        [2, 1], // CLAP_EVENT_NOTE_OFF
    ]);
    plugin.destroy();
});

test("Midi2Echo (MIDI 2 only): notes and channel messages arrive as MIDI 2 packets, sysex as sysex, and come back as MIDI", async () => {
    const plugin = await echo("dev.wclap-ts.midi2-echo");
    const audio = plugin.process(16, [
        { at: 1, type: "note-on", key: 60, velocity: 1, channel: 1 },
        { at: 2, type: "midi", data: Uint8Array.of(0xe1, 0, 64), offset: 0, size: 3 },
        { at: 3, type: "midi", data: Uint8Array.from(sysex(10)), offset: 0, size: 10 },
        { at: 4, type: "note-off", key: 60, velocity: 0, channel: 1 },
    ]);
    assert.deepEqual(marks(audio[0]?.[0]), [
        [1, CLAP_EVENT_MIDI2],
        [2, CLAP_EVENT_MIDI2],
        [3, CLAP_EVENT_MIDI_SYSEX],
        [4, CLAP_EVENT_MIDI2],
    ]);
    assert.deepEqual(out(plugin), [
        [1, "note-on", 60],
        [2, 0xe1, 0, 64],
        [3, ...sysex(10)],
        [4, "note-off", 60],
    ]);
    plugin.destroy();
});

test("the dialect comes from the plug-in's note input: probe prefers CLAP, MidiEcho MIDI, Midi2Echo MIDI 2", async () => {
    const fixture = TEST_PLUGINS.find((f) => f.name === "probe");
    assert.ok(fixture);
    const instance = Instance.create(await openBundle(await fetchFixture(fixture)), { log: () => undefined });
    const probe = Plugin.create(instance, instance.plugins()[0]?.id ?? "", () => undefined);
    probe.activate(48000, 128);
    const midiEcho = await echo();
    const midi2Echo = await echo("dev.wclap-ts.midi2-echo");
    assert.deepEqual(
        [probe, midiEcho, midi2Echo].map((p) => p.audio?.setup.dialect),
        [CLAP_NOTE_DIALECT_CLAP, CLAP_NOTE_DIALECT_MIDI, CLAP_NOTE_DIALECT_MIDI2],
    );
    for (const p of [probe, midiEcho, midi2Echo]) p.destroy();
});

test("a chain passes a plug-in's MIDI output to the next plug-in and out of the chain", async () => {
    const first = await echo();
    const second = await echo();
    const queue = EventQueue.create();
    const chain = new Chain(new Scheduler(queue), 48000);
    chain.add({ id: 1, processor: first, ports: first.ports, enabled: true, failed: false });
    chain.add({ id: 2, processor: second, ports: second.ports, enabled: true, failed: false });
    const left: number[][] = [];
    chain.onNotesOut = (blockStart, list, count) => {
        for (let i = 0; i < count; i++) {
            const e = list[i];
            left.push(e?.type === "midi" ? [blockStart + e.at, ...(bytes(e) ?? [])] : [blockStart + (e?.at ?? 0)]);
        }
    };
    queue.push(3, midi([0xe0, 1, 2]));
    queue.push(4, midi(sysex(20)));
    queue.push(5, midi([0xc0, 7]));
    const audio = [[new Float32Array(128), new Float32Array(128)]];
    chain.render(0, 128, [], audio);
    // The chain's output is the second plug-in's: it received every message the first sent on.
    assert.deepEqual(marks(audio[0]?.[0]), [
        [3, CLAP_EVENT_MIDI],
        [4, CLAP_EVENT_MIDI_SYSEX],
        [5, CLAP_EVENT_MIDI],
    ]);
    assert.deepEqual(left, [
        [3, 0xe0, 1, 2],
        [4, ...sysex(20)],
        [5, 0xc0, 7],
    ]);
    first.destroy();
    second.destroy();
});

// Web MIDI, with navigator.requestMIDIAccess faked: a host that records what reaches it.
class FakeInput extends EventTarget {
    send(data: number[], timeStamp = 1000) {
        const e = new globalThis.Event("midimessage");
        Object.defineProperty(e, "data", { value: Uint8Array.from(data) });
        Object.defineProperty(e, "timeStamp", { value: timeStamp });
        this.dispatchEvent(e);
    }
}
const fakeAccess = () => {
    const input = new FakeInput();
    const access = Object.assign(new EventTarget(), { inputs: new Map([["in", input]]) });
    const asked: unknown[] = [];
    Object.defineProperty(globalThis, "navigator", {
        value: {
            requestMIDIAccess: async (options?: unknown) => {
                asked.push(options);
                return access;
            },
        },
        configurable: true,
    });
    return { input, asked };
};
const fakeHost = () => {
    const sent: { bytes: number[]; target: number; sourceMs: number }[] = [];
    const scheduled: Timed[] = [];
    const host = Object.assign(new EventTarget(), {
        context: { currentTime: 1 },
        sendMidi: (data: Uint8Array, _when: number | undefined, target: number, sourceMs: number) =>
            sent.push({ bytes: [...data], target, sourceMs }) > 0,
        schedule: (event: Timed) => scheduled.push(event) > 0,
    });
    return { host: host as unknown as WclapHost, sent, scheduled };
};

test("Web MIDI input: every message reaches the host, sysex only when asked for; a mapped CC moves its parameter instead", async () => {
    const { input, asked } = fakeAccess();
    const { host, sent, scheduled } = fakeHost();
    const midiIn = new Midi(host);
    const plugin = { id: 4, params: [{ id: 9, min: 0, max: 2 }] } as unknown as WclapPlugin;
    midiIn.mapCC(74, plugin, 9);
    const stop = await midiIn.connect();
    assert.deepEqual(asked, [{ sysex: false }]);
    const messages = [[0x90, 60, 100], [0xe0, 0, 64], [0xa0, 60, 30], [0xd0, 40], [0xc0, 5], [0xb0, 1, 64], sysex(12)];
    for (const m of messages) input.send(m, 1234);
    input.send([0xb0, 74, 127]);
    stop();
    input.send([0x90, 61, 100]);
    assert.deepEqual(
        sent.map((s) => s.bytes),
        messages,
    );
    assert.ok(sent.every((s) => s.target === -1 && s.sourceMs === 1234));
    assert.deepEqual(scheduled, [{ type: "param", id: 9, value: 2 }], "the mapped CC moved Level, and wasn't sent");
    await new Midi(host).connect({ sysex: true });
    assert.deepEqual(asked[1], { sysex: true });
});

test("connectMidiOut sends every midiout message's bytes at its time", () => {
    const { host } = fakeHost();
    const midiOut = new Midi(host);
    const sends: [number[], number][] = [];
    const output = { send: (data: number[], at: number) => void sends.push([[...data], at]) } as unknown as MIDIOutput;
    const stop = midiOut.connectOut(output);
    const now = performance.now();
    host.dispatchEvent(new CustomEvent("midiout", { detail: { data: Uint8Array.of(0xe0, 0, 64), time: 1.5 } }));
    stop();
    host.dispatchEvent(new CustomEvent("midiout", { detail: { data: Uint8Array.of(0xd0, 1), time: 1.5 } }));
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]?.[0], [0xe0, 0, 64]);
    assert.ok(Math.abs((sends[0]?.[1] ?? 0) - (now + 500)) < 50);
});
