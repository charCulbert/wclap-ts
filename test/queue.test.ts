import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue, Scheduler } from "../src/events/event-queue.ts";

const keys = (s: Scheduler, blockStart: number, frames = 128) => {
    const { events, count } = s.take(blockStart, frames);
    return events
        .slice(0, count)
        .map((e) =>
            e.type === "note-on" || e.type === "note-off"
                ? `${e.type}${e.key}@${e.at}`
                : `p${"id" in e ? e.id : ""}@${e.at}`,
        );
};

test("events come out in their block, at their frame, in time order", () => {
    const queue = EventQueue.create(16);
    const s = new Scheduler(queue, 16);
    queue.push(300, { type: "note-on", key: 62, velocity: 1 });
    queue.push(10, { type: "note-on", key: 60, velocity: 1 });
    queue.push(10, { type: "param", id: 3, value: 0.5 });
    queue.push(130, { type: "note-off", key: 60, velocity: 0 });
    assert.deepEqual(keys(s, 0), ["note-on60@10", "p3@10"]);
    assert.deepEqual(keys(s, 128), ["note-off60@2"]);
    assert.deepEqual(keys(s, 256), ["note-on62@44"]);
    assert.deepEqual(keys(s, 384), []);
});

test("a late event plays at the start of the next block, and is counted", () => {
    const queue = EventQueue.create(16);
    const s = new Scheduler(queue, 16);
    keys(s, 0);
    queue.push(50, { type: "note-on", key: 60, velocity: 1 });
    assert.deepEqual(keys(s, 128), ["note-on60@0"]);
    assert.equal(s.late, 1);
});

test("a full queue refuses events instead of overwriting them", () => {
    const queue = EventQueue.create(4);
    for (let i = 0; i < 4; i++) assert.ok(queue.push(i, { type: "param", id: i, value: 0 }));
    assert.equal(queue.push(9, { type: "param", id: 9, value: 0 }), false);
    const s = new Scheduler(queue, 16);
    assert.deepEqual(keys(s, 0), ["p0@0", "p1@1", "p2@2", "p3@3"]);
    assert.ok(queue.push(200, { type: "param", id: 9, value: 0 }));
});

test("the ring wraps around many times", () => {
    const queue = EventQueue.create(8);
    const s = new Scheduler(queue, 8);
    for (let block = 0; block < 100; block++) {
        for (let i = 0; i < 5; i++) queue.push(block * 128 + i * 20, { type: "param", id: i, value: block });
        const { events, count } = s.take(block * 128, 128);
        assert.equal(count, 5);
        assert.deepEqual(
            events.slice(0, count).map((e) => e.at),
            [0, 20, 40, 60, 80],
        );
    }
});

test("pending events past the scheduler's capacity are dropped and counted", () => {
    const queue = EventQueue.create(16);
    const s = new Scheduler(queue, 2);
    for (let i = 0; i < 3; i++) queue.push(1000 + i, { type: "param", id: i, value: 0 });
    keys(s, 0);
    assert.equal(s.dropped, 1);
});

test("a full scheduler gives up another event before a note-off, so no note hangs", () => {
    const queue = EventQueue.create(16);
    const s = new Scheduler(queue, 3);
    queue.push(10, { type: "note-on", key: 60, velocity: 1 });
    queue.push(20, { type: "param", id: 1, value: 0 });
    queue.push(30, { type: "param", id: 2, value: 0 });
    queue.push(40, { type: "note-off", key: 60, velocity: 0 });
    assert.deepEqual(keys(s, 0), ["note-on60@10", "p1@20", "note-off60@40"]);
    assert.equal(s.dropped, 1);
});

test("drain decodes what the audio side sends back", () => {
    const queue = EventQueue.create(16);
    queue.push(5, { type: "param", id: 3, value: 0.5 }, 7);
    queue.push(9, { type: "note-off", key: 61, velocity: 0, channel: 2 });
    const seen: string[] = [];
    queue.drain((frame, e) =>
        seen.push(
            e.type === "param"
                ? `${frame} p${e.id}=${e.value} t${e.target}`
                : `${frame} ${e.type}${"key" in e ? e.key : ""}`,
        ),
    );
    assert.deepEqual(seen, ["5 p3=0.5 t7", "9 note-off61"]);
});

test("modulations, expressions and targets travel intact", () => {
    const queue = EventQueue.create(16);
    const s = new Scheduler(queue, 16);
    queue.push(1, { type: "param-mod", id: 7, value: 0.25 }, 3);
    queue.push(2, { type: "param-mod", id: 7, value: -0.5, key: 64, channel: 2 });
    queue.push(3, { type: "expression", expression: 2, key: 60, value: 1.5, channel: 1 });
    const { events, count } = s.take(0, 128);
    const plain = events.slice(0, count).map((e) => ({ ...e }));
    assert.deepEqual(plain[0], { ...plain[0], type: "param-mod", id: 7, value: 0.25, key: undefined, target: 3 });
    assert.deepEqual(plain[1], { ...plain[1], type: "param-mod", id: 7, value: -0.5, key: 64, channel: 2, target: -1 });
    assert.deepEqual(plain[2], { ...plain[2], type: "expression", expression: 2, key: 60, value: 1.5, channel: 1 });
});

test("a burst larger than one block's limit is split across blocks, never refused", () => {
    const queue = EventQueue.create(1024);
    const s = new Scheduler(queue, 1024);
    for (let i = 0; i < 300; i++) queue.push(5, { type: "param", id: i, value: 0 });
    const first = s.take(0, 128);
    assert.equal(first.count, 256);
    const second = s.take(128, 128);
    assert.equal(second.count, 44);
    assert.equal(second.events[0]?.at, 0);
    assert.equal(s.late, 44);
    assert.equal(first, second, "the same result object, reused");
});
