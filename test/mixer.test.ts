import assert from "node:assert/strict";
import { test } from "node:test";
import { Mixer } from "../examples/mixer.ts";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";
import { OutputList } from "../src/plugin/clap-host-callbacks.ts";
import type { Transport } from "../src/plugin/plugin-types.ts";
import { Runner, type Slot } from "../src/worklet/plugin-runner.ts";
import type { HostContext } from "../src/worklet/topology.ts";

// The host's side, as processor.ts does it: one block's events shared, one runner, one transport.
function host() {
    const queue = EventQueue.create();
    const scheduler = new Scheduler(queue);
    const transport: Transport = { tempo: 120, playing: true, beats: 0, seconds: 0 };
    const runner = new Runner(transport);
    runner.onFailure = (_id, error) => {
        throw error;
    };
    let block: { events: readonly import("../src/plugin/plugin-types.ts").Event[]; count: number } = {
        events: [],
        count: 0,
    };
    const context: HostContext = {
        sampleRate: 48000,
        transport,
        runner,
        events: { take: () => block },
        options: undefined,
        post: () => undefined,
        notesOut: () => undefined,
    };
    const slots: Slot[] = [];
    const render = (mixer: Mixer, start: number) => {
        block = scheduler.take(start, 128);
        runner.beginBlock();
        const out = [[new Float32Array(128), new Float32Array(128)]];
        mixer.render(start, 128, [], out);
        runner.endBlock(slots, block.events, block.count);
        return out[0]?.[0] ?? new Float32Array();
    };
    return { queue, runner, context, slots, render };
}

// An instrument whose sound is a click `latency` frames after its note.
function clicker(id: number, latency: number): Slot {
    let due = -1;
    let frame = 0;
    const out = [[new Float32Array(128), new Float32Array(128)]];
    return {
        id,
        enabled: true,
        failed: false,
        ports: { inputs: [], outputs: [2] },
        processor: {
            output: new OutputList(),
            process(frames, events, _inputs, count) {
                for (let i = 0; i < count; i++)
                    if (events[i]?.type === "note-on") due = frame + (events[i]?.at ?? 0) + latency;
                for (const channel of out[0] ?? []) channel.fill(0);
                if (due >= frame && due < frame + frames) for (const channel of out[0] ?? []) channel[due - frame] = 1;
                frame += frames;
                return out;
            },
        },
    };
}

// An effect that delays its input by `latency` frames.
function delayer(id: number, latency: number): Slot {
    const line = new Float32Array(48000);
    let at = 0;
    const out = [[new Float32Array(128), new Float32Array(128)]];
    return {
        id,
        enabled: true,
        failed: false,
        ports: { inputs: [2], outputs: [2] },
        processor: {
            output: new OutputList(),
            process(frames, _events, inputs) {
                for (let k = 0; k < frames; k++) {
                    line[at] = inputs[0]?.[0]?.[k] ?? 0;
                    const v = line[(at - latency + line.length) % line.length] ?? 0;
                    for (const channel of out[0] ?? []) channel[k] = v;
                    at = (at + 1) % line.length;
                }
                return out;
            },
        },
    };
}

test("the mixer lines up two tracks and a bus to the sample: dry and wet arrive together", () => {
    const h = host();
    const mixer = new Mixer(h.context);
    const slow = clicker(1, 24);
    const fast = clicker(2, 0);
    const bus = delayer(3, 10);
    for (const s of [slow, fast, bus]) {
        h.slots.push(s);
        h.runner.add(s.id);
        mixer.add(s);
    }
    mixer.message({
        tracks: [
            { plugins: [1], gain: 1 },
            { plugins: [2], gain: 1 },
            { plugins: [3], gain: 1, bus: true },
        ],
        sends: [
            { from: 0, to: 2, gain: 1 },
            { from: 1, to: 2, gain: 1 },
        ],
        latency: [24, 0, 10],
    });
    h.queue.push(100, { type: "note-on", key: 60, velocity: 1 }, 1);
    h.queue.push(100, { type: "note-on", key: 60, velocity: 1 }, 2);
    const out = new Float32Array(256);
    out.set(h.render(mixer, 0), 0);
    out.set(h.render(mixer, 128), 128);
    const hits = [...out.keys()].filter((k) => (out[k] ?? 0) !== 0);
    // Both clicks at 100 + 24 (the slowest source) + 10 (the bus), dry and through the bus: 2 + 2.
    assert.deepEqual(hits, [134]);
    assert.equal(out[134], 4);
});

test("a plug-in that isn't routed yet still gets idle time and its parameter changes", () => {
    const h = host();
    const mixer = new Mixer(h.context);
    let idles = 0;
    const flushed: number[] = [];
    const slot: Slot = {
        id: 7,
        enabled: true,
        failed: false,
        ports: { inputs: [], outputs: [2] },
        processor: {
            output: new OutputList(),
            process: () => null,
            idle: () => void idles++,
            flush: (events, count) => {
                for (let i = 0; i < count; i++) {
                    const e = events[i];
                    if (e?.type === "param") flushed.push(e.id);
                }
            },
        },
    };
    h.slots.push(slot);
    h.runner.add(7);
    mixer.add(slot);
    h.queue.push(0, { type: "param", id: 4, value: 1 }, 7);
    h.render(mixer, 0);
    assert.equal(idles, 1);
    assert.deepEqual(flushed, [4]);
});

test("rerouting keeps a track's plug-ins and held notes; untargeted notes go to the chosen track", () => {
    const h = host();
    const mixer = new Mixer(h.context);
    const a = clicker(1, 0);
    const b = clicker(2, 0);
    for (const s of [a, b]) {
        h.slots.push(s);
        h.runner.add(s.id);
        mixer.add(s);
    }
    const routing = (input: number) => ({
        tracks: [
            { plugins: [1], gain: 1, input: input === 0 },
            { plugins: [2], gain: 0, input: input === 1 },
        ],
        sends: [],
        latency: [0, 0],
    });
    mixer.message(routing(0));
    h.queue.push(10, { type: "note-on", key: 60, velocity: 1 });
    assert.equal(h.render(mixer, 0)[10], 1, "the untargeted note played track 0");
    mixer.message(routing(1));
    h.queue.push(138, { type: "note-on", key: 60, velocity: 1 });
    assert.ok(
        h.render(mixer, 128).every((v) => v === 0),
        "now track 1 (silent at gain 0) takes it, not track 0",
    );
});
