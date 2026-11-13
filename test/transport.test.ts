import assert from "node:assert/strict";
import { test } from "node:test";
import { Transport, type TransportAnchor } from "../src/page/transport.ts";

const fakeContext = () => ({ currentTime: 0, sampleRate: 48000 }) as { currentTime: number; sampleRate: number };

test("a shared transport: changes land on a block ahead, the same for every host, and the song moves on smoothly", () => {
    const context = fakeContext();
    const transport = new Transport(context as unknown as BaseAudioContext, { tempo: 120 });
    const a: TransportAnchor[] = [];
    const b: TransportAnchor[] = [];
    transport.follow((anchor) => a.push(anchor));
    transport.follow((anchor) => b.push(anchor));
    assert.equal(a.length, 1, "a host gets where the song is as soon as it follows");

    context.currentTime = 2; // 4 beats at 120 bpm
    assert.equal(transport.beats, 4);
    transport.tempo = 60;
    const change = a.at(-1);
    assert.ok(change);
    assert.deepEqual(change, b.at(-1), "every host gets the same anchor");
    assert.equal(change.frame % 128, 0, "on a block boundary");
    assert.ok(change.frame > 2 * 48000, "ahead of now, so it reaches every host in time");
    assert.ok(Math.abs(change.beats - (change.frame / 48000) * 2) < 1e-9, "no jump in position at the change");

    context.currentTime = change.frame / 48000 + 1;
    assert.ok(Math.abs(transport.beats - (change.beats + 1)) < 1e-9, "the new tempo from the change on");

    transport.playing = false;
    const stopped = transport.beats;
    context.currentTime += 5;
    assert.ok(Math.abs(transport.beats - stopped) < 0.1, "stopped: the position holds");

    transport.seek(16);
    assert.equal(a.at(-1)?.beats, 16);
    assert.equal(a.at(-1)?.seconds, 16);
});

test("changes made together land together, the last one winning", () => {
    const context = fakeContext();
    const transport = new Transport(context as unknown as BaseAudioContext);
    const got: TransportAnchor[] = [];
    transport.follow((anchor) => got.push(anchor));
    context.currentTime = 1;
    transport.tempo = 90;
    transport.setTimeSignature(3, 4);
    const [, first, second] = got;
    assert.equal(first?.frame, second?.frame);
    assert.deepEqual([second?.tempo, second?.numerator, second?.denominator], [90, 3, 4]);
});
