import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAP, type TempoMap } from "../src/events/timeline.ts";
import { type TransportAnchor, TransportClock } from "../src/worklet/transport-clock.ts";

const anchor = (a: Partial<TransportAnchor>): TransportAnchor => ({
    frame: 0,
    beats: 0,
    playing: true,
    map: DEFAULT_MAP,
    loop: null,
    ...a,
});
const changes = (clock: TransportClock) => clock.transport.changes?.slice(0, clock.transport.changeCount) ?? [];

test("a loop end in the middle of a block wraps on its frame", () => {
    // 120 bpm at 48 kHz: a beat is 24000 frames. Loop beats 0 to 1, so it wraps at frame 24000, inside block 187.
    const clock = new TransportClock(48000);
    clock.push(anchor({ loop: { startBeat: 0, endBeat: 1 } }));
    const block = Math.floor(24000 / 128) * 128;
    clock.block(block - 128, 128);
    assert.equal(changes(clock).length, 0);
    clock.block(block, 128);
    const [wrap] = changes(clock);
    assert.equal(wrap?.at, 24000 - block, "on the frame the loop ends");
    assert.equal(wrap?.beats, 0, "back at the loop start");
    assert.ok(wrap?.looping);
    assert.equal(wrap?.loopEnd, 1);
    clock.block(block + 128, 128);
    assert.ok(Math.abs(clock.transport.beats - (block + 128 - 24000) / 24000) < 1e-9, "and plays on from there");
    assert.equal(changes(clock).length, 0);
});

test("a tempo point and a change from the page land on their frames, inside the block", () => {
    const map: TempoMap = {
        tempos: [
            { beat: 0, bpm: 120 },
            { beat: 1, bpm: 60 },
        ],
        signatures: DEFAULT_MAP.signatures,
    };
    const clock = new TransportClock(48000);
    clock.push(anchor({ map }));
    clock.push(anchor({ frame: 24050, beats: 8, map }));
    clock.block(24000 - 10, 128);
    const [point, seek] = changes(clock);
    assert.deepEqual([point?.at, point?.tempo, point?.beats], [10, 60, 1], "the tempo point");
    assert.deepEqual([seek?.at, seek?.beats], [60, 8], "the seek, on its frame");
    assert.equal(clock.transport.tempo, 120, "the block starts at the old tempo");
});

test("a ramp: tempo_inc while gliding, and bars from the signature", () => {
    const map: TempoMap = {
        tempos: [
            { beat: 0, bpm: 120, ramp: true },
            { beat: 4, bpm: 60 },
        ],
        signatures: [{ beat: 0, numerator: 3, denominator: 4 }],
    };
    const clock = new TransportClock(48000);
    clock.push(anchor({ map, beats: 3.5 }));
    clock.block(0, 128);
    const t = clock.transport;
    assert.ok(Math.abs((t.tempoInc ?? 0) - -22.5 / 48000) < 1e-12, "bpm per frame");
    assert.deepEqual([t.bar, t.barStart, t.numerator], [1, 3, 3]);
});

test("stopped: the position holds and nothing changes inside blocks", () => {
    const clock = new TransportClock(48000);
    clock.push(anchor({ beats: 2, playing: false, loop: { startBeat: 0, endBeat: 2.001 } }));
    clock.block(0, 128);
    clock.block(48000, 128);
    assert.equal(clock.transport.beats, 2);
    assert.equal(clock.transport.tempoInc, 0);
    assert.equal(changes(clock).length, 0);
});
