import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "../src/events/live-event-clock.ts";

// A controlled clock for performance.now(), and an AudioContext on it whose output timestamps wobble by up to a
// render quantum, as browsers' do.
let now = 1000;
performance.now = () => now;

function jitteryContext(rate = 48000) {
    let random = 1;
    const wobble = () => {
        random = (random * 16807) % 2147483647;
        return (random / 2147483647) * (128 / rate);
    };
    return {
        sampleRate: rate,
        get currentTime() {
            return (now - 1000) / 1000 + 0.01;
        },
        getOutputTimestamp() {
            return { contextTime: (now - 1000) / 1000 - wobble(), performanceTime: now };
        },
        addEventListener() {},
    } as unknown as AudioContext;
}

test("events keep their spacing: the offset from source time holds steady despite timestamp jitter", () => {
    const rate = 48000;
    const clock = new Clock(jitteryContext(rate), 256 / rate);
    const offsets: number[] = [];
    for (let i = 0; i < 500; i++) {
        now += 3 + (i % 7);
        offsets.push(clock.frameAt(now) - (now * rate) / 1000);
    }
    const spread = Math.max(...offsets) - Math.min(...offsets);
    // Only the slow ease-down moves it: 1 ms per second, over about 3 s here.
    assert.ok(spread < 3 * 48 + 2, `offset moved ${spread.toFixed(1)} frames`);
    const steps = offsets.slice(1).map((o, i) => Math.abs(o - (offsets[i] ?? o)));
    assert.ok(Math.max(...steps) < 1, "no event moves more than a frame against the one before");
});

test("an event that arrives late raises the offset rather than playing late", () => {
    const rate = 48000;
    const context = jitteryContext(rate);
    const clock = new Clock(context, 256 / rate);
    now += 10;
    clock.frameAt(now);
    const source = now;
    now += 20; // the page was busy for 20 ms before handling this event
    const frame = clock.frameAt(source);
    assert.ok(frame >= Math.floor((context.currentTime + 256 / rate) * rate) - 1);
});
