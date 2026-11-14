import assert from "node:assert/strict";
import { test } from "node:test";
import { Transport, type TransportAnchor } from "../src/page/transport.ts";

const fakeContext = () => ({ currentTime: 0, sampleRate: 48000 }) as { currentTime: number; sampleRate: number };
const close = (got: number | undefined, want: number, what: string) =>
    assert.ok(Math.abs((got ?? Number.NaN) - want) < 1e-9, `${what}: ${got}`);

test("a shared transport: every host gets the same anchor, a little ahead, and the song moves on smoothly", () => {
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
    assert.equal(transport.tempo, 60, "reads as set at once, though it lands a little ahead");
    const change = a.at(-1);
    assert.ok(change);
    assert.deepEqual(change, b.at(-1), "every host gets the same anchor");
    assert.ok(change.frame > 2 * 48000, "ahead of now, so it reaches every host in time");
    close(change.beats, (change.frame / 48000) * 2, "no jump in position at the change");
    assert.deepEqual(
        change.map.tempos,
        [
            { beat: 0, bpm: 120 },
            { beat: change.beats, bpm: 60 },
        ],
        "from there on",
    );

    context.currentTime = change.frame / 48000 + 1;
    close(transport.beats, change.beats + 1, "the new tempo from the change on");
    assert.equal(transport.tempo, 60);

    transport.playing = false;
    const stopped = transport.beats;
    context.currentTime += 5;
    close(transport.beats, stopped, "stopped: the position holds");

    transport.seek(16);
    assert.equal(a.at(-1)?.beats, 16);
});

test("a change at a time lands on that time's frame, not a block boundary", () => {
    const context = fakeContext();
    const transport = new Transport(context as unknown as BaseAudioContext);
    const got: TransportAnchor[] = [];
    transport.follow((anchor) => got.push(anchor));
    transport.seek(8, 1 + 50 / 48000);
    assert.equal(got.at(-1)?.frame, 48050);
    transport.stop(0.5);
    assert.equal(got.at(-1)?.frame, 48050, "never before the last change");
    transport.play(0);
    assert.equal(got.at(-1)?.frame, 48050);
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
    assert.equal(second?.map.tempos.at(-1)?.bpm, 90);
    assert.deepEqual(second?.map.signatures, [{ beat: 0, numerator: 3, denominator: 4 }]);
});

test("a loop: the page's position wraps as the audio side does; a new map keeps the position in beats", () => {
    const context = fakeContext();
    const transport = new Transport(context as unknown as BaseAudioContext);
    transport.setLoop({ startBeat: 2, endBeat: 4 });
    context.currentTime = 2.5; // beat 5 without the loop: one beat past its end, so beat 3
    close(transport.beats, 3, "wrapped");
    assert.throws(() => transport.setLoop({ startBeat: 4, endBeat: 4 }), /ends after it starts/);
    transport.setLoop(null);
    const before = transport.beats;
    transport.setMap({ tempos: [{ beat: 0, bpm: 60 }], signatures: [] });
    close(transport.beats, before, "the same beat under the new map");
});
