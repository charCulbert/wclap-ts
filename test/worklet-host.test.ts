import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue } from "../src/events/event-queue.ts";
import type { TransportAnchor } from "../src/page/transport.ts";
import type { Transport } from "../src/plugin/plugin-types.ts";
import type { HostContext } from "../src/worklet/topology.ts";

// Just enough of an AudioWorkletGlobalScope for the host to run: set before the module loads, since it picks its
// base class then.
const sent: { type: string; message?: string }[] = [];
class FakeProcessor {
    readonly port = {
        onmessage: null as ((message: { data: unknown }) => void) | null,
        postMessage: (message: { type: string }) => void sent.push(message),
    };
}
const scope = globalThis as unknown as Record<string, unknown>;
const registered = new Map<string, new (options: unknown) => object>();
scope.AudioWorkletProcessor = FakeProcessor;
scope.registerProcessor = (name: string, processor: new (options: unknown) => object) =>
    registered.set(name, processor);
scope.sampleRate = 48000;
scope.currentFrame = 0;
const { registerWclapProcessor } = await import("../src/worklet/worklet-host.ts");

interface Node {
    port: FakeProcessor["port"];
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const create = (name: string, render: (transport: Transport) => void): Node => {
    registerWclapProcessor(name, (host: HostContext) => ({
        add: () => undefined,
        remove: () => undefined,
        render: () => render(host.transport),
    }));
    const Processor = registered.get(name);
    assert.ok(Processor);
    const processorOptions = { queue: EventQueue.create().buffer, back: EventQueue.create().buffer, maxFrames: 128 };
    return new Processor({ processorOptions }) as unknown as Node;
};

const block = (node: Node, frame: number) => {
    scope.currentFrame = frame;
    const outputs = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
    assert.equal(node.process([], outputs), true);
    return outputs;
};

test("transport changes the page sends reach the arrangement from their frame on", () => {
    const seen: Transport[] = [];
    const node = create("transport-test", (t) => void seen.push({ ...t }));
    const map = (bpm: number, numerator = 4, denominator = 4) => ({
        tempos: [{ beat: 0, bpm }],
        signatures: [{ beat: 0, numerator, denominator }],
    });
    const anchor = (a: Partial<TransportAnchor>): TransportAnchor => ({
        frame: 0,
        beats: 0,
        playing: true,
        map: map(120),
        loop: null,
        ...a,
    });
    node.port.onmessage?.({ data: { type: "transport", anchor: anchor({ frame: 256, beats: 8, map: map(90) }) } });
    node.port.onmessage?.({
        data: { type: "transport", anchor: anchor({ frame: 48256, beats: 20, playing: false, map: map(60, 7, 8) }) },
    });
    block(node, 128);
    assert.equal(seen[0]?.tempo, 120, "before the first anchor's frame, the default");
    block(node, 256);
    assert.deepEqual(
        [seen[1]?.tempo, seen[1]?.beats, seen[1]?.seconds, seen[1]?.frame],
        [90, 8, (8 * 60) / 90, 256],
        "on its frame",
    );
    block(node, 256 + 24000);
    assert.ok(Math.abs((seen[2]?.beats ?? 0) - 8.75) < 1e-9, "half a second on at 90 BPM");
    block(node, 48256 + 4800);
    assert.deepEqual(
        [seen[3]?.tempo, seen[3]?.playing, seen[3]?.numerator, seen[3]?.denominator, seen[3]?.beats],
        [60, false, 7, 8, 20],
        "stopped: the song stays where it was put",
    );
});

test("an arrangement that throws gives a silent block, says so once, and is tried again next block", () => {
    let calls = 0;
    const node = create("throw-test", () => {
        calls++;
        throw new Error("a broken graph");
    });
    sent.length = 0;
    // From one call site, as the audio thread calls it: the same error has the same stack every block.
    const outs = [0, 128, 256].map((frame) => block(node, frame));
    assert.ok(outs.flat(2).every((channel) => channel.every((v) => v === 0)));
    assert.equal(calls, 3);
    const errors = sent.filter((m) => m.type === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? "", /a block failed on the audio thread: Error: a broken graph/);
});
