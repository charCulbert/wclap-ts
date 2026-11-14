import assert from "node:assert/strict";
import { test } from "node:test";
import { barAt, beatsToSeconds, secondsToBeats, type TempoMap, Timeline } from "../src/events/timeline.ts";

const close = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got}`);
const fourFour = [{ beat: 0, numerator: 4, denominator: 4 }];

test("a tempo step: 120 to 60 at beat 4 puts beat 8 at 6 s, and back again", () => {
    const map: TempoMap = {
        tempos: [
            { beat: 0, bpm: 120 },
            { beat: 4, bpm: 60 },
        ],
        signatures: fourFour,
    };
    close(beatsToSeconds(map, 4), 2, "beat 4");
    close(beatsToSeconds(map, 8), 6, "beat 8");
    close(secondsToBeats(map, 6), 8, "6 s");
    close(secondsToBeats(map, 1), 2, "1 s");
});

test("a linear ramp 120 to 60 over 4 beats, linear in time: beat 4 at 8/3 s, the tempo gliding", () => {
    const map: TempoMap = {
        tempos: [
            { beat: 0, bpm: 120, ramp: true },
            { beat: 4, bpm: 60 },
        ],
        signatures: fourFour,
    };
    const t = new Timeline(map);
    // 4 beats at an average of 90 bpm.
    close(t.secondsAt(4), 8 / 3, "beat 4");
    close(t.beatsAt(8 / 3), 4, "8/3 s");
    close(t.tempoAt(t.beatsAt(4 / 3)), 90, "halfway in time, halfway in tempo");
    close(t.slopeAt(1), -22.5, "bpm per second while ramping");
    close(t.slopeAt(5), 0, "steady after");
    close(t.secondsAt(6), 8 / 3 + 2, "60 bpm after the ramp");
    for (const b of [0.5, 1, 2.5, 3.9]) close(t.beatsAt(t.secondsAt(b)), b, `round trip ${b}`);
});

test("bars through a signature change, and before the start", () => {
    const map: TempoMap = {
        tempos: [{ beat: 0, bpm: 120 }],
        signatures: [
            { beat: 0, numerator: 4, denominator: 4 },
            { beat: 8, numerator: 3, denominator: 4 },
            { beat: 14, numerator: 6, denominator: 8 },
        ],
    };
    assert.deepEqual(barAt(map, 5), { bar: 1, start: 4, numerator: 4, denominator: 4 });
    assert.deepEqual(barAt(map, 8), { bar: 2, start: 8, numerator: 3, denominator: 4 });
    assert.deepEqual(barAt(map, 13.5), { bar: 3, start: 11, numerator: 3, denominator: 4 });
    assert.deepEqual(barAt(map, 14), { bar: 4, start: 14, numerator: 6, denominator: 8 });
    assert.deepEqual(barAt(map, 17.5), { bar: 5, start: 17, numerator: 6, denominator: 8 });
    assert.deepEqual(barAt(map, -1), { bar: -1, start: -4, numerator: 4, denominator: 4 });
    close(beatsToSeconds(map, -2), -1, "before beat 0");
    close(secondsToBeats(map, -1), -2, "before 0 s");
});

test("a map that starts late: its first tempo holds before it; nextPoint finds the changes", () => {
    const map: TempoMap = {
        tempos: [
            { beat: 4, bpm: 60 },
            { beat: 8, bpm: 120 },
        ],
        signatures: [],
    };
    const t = new Timeline(map);
    close(t.secondsAt(4), 4, "60 bpm from beat 0");
    close(t.secondsAt(10), 9, "120 after beat 8");
    assert.equal(t.nextPoint(0), 4);
    assert.equal(t.nextPoint(4), 8);
    assert.equal(t.nextPoint(8), Number.POSITIVE_INFINITY);
    const { numerator, denominator } = t.signatureAt(3);
    assert.deepEqual([numerator, denominator], [4, 4], "4/4 when there are none");
});
