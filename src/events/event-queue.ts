// Events from one writer (the page) to the audio side, through shared memory, each stamped with the audio frame it
// should land on. The audio side keeps them in time order until their block and never allocates.
import { MAX_EVENTS } from "../plugin/clap-host-callbacks.ts";
import type { Event } from "../plugin/plugin-types.ts";
import { HeldNotes } from "./held-notes.ts";

// An event without its frame in a block: the queue stamps it with an audio frame instead. Note IDs aren't carried:
// the scheduler gives them out (a NOTE_END only ever comes from a plug-in).
type Queued = Exclude<Event, { type: "note-end" }>;
export type Timed = Queued extends infer E ? (E extends unknown ? Omit<E, "at" | "noteId"> : never) : never;

// frame, kind, key or id, velocity or value, channel, target, and per kind: a modulation's key, an expression's id
const FIELDS = 7;
const KINDS = [
    "note-on",
    "note-off",
    "param",
    "param-mod",
    "expression",
    "gesture-begin",
    "gesture-end",
    "note-choke",
] as const;
const NOTE_OFF = KINDS.indexOf("note-off");
const NOTE_CHOKE = KINDS.indexOf("note-choke");
// Note-offs and chokes end notes: they're never the event dropped to make room.
const ends = (kind: number | undefined) => kind === NOTE_OFF || kind === NOTE_CHOKE;
// Note IDs count up from 0 and start again past the largest a CLAP note ID can be.
const MAX_NOTE_ID = 0x7fffffff;

// A ring of entries with one slot always free, so "full" and "empty" differ; the two indices are atomics.
export class EventQueue {
    readonly buffer: SharedArrayBuffer;
    readonly capacity: number;
    readonly #indices: Int32Array;
    readonly #entries: Float64Array;

    static create(capacity = 1024): EventQueue {
        return new EventQueue(new SharedArrayBuffer(8 + (capacity + 1) * FIELDS * 8));
    }

    constructor(buffer: SharedArrayBuffer) {
        this.buffer = buffer;
        this.#indices = new Int32Array(buffer, 0, 2);
        this.#entries = new Float64Array(buffer, 8);
        this.capacity = this.#entries.length / FIELDS - 1;
    }

    // Writer side. False when the queue is full: the audio side isn't keeping up, and the event is dropped.
    // `target`: the plug-in the event is for, or -1 for the start of the chain.
    push(frame: number, event: Timed, target = -1): boolean {
        const write = Atomics.load(this.#indices, 0);
        const next = (write + 1) % (this.capacity + 1);
        if (next === Atomics.load(this.#indices, 1)) return false;
        const e = this.#entries;
        const at = write * FIELDS;
        e[at] = frame;
        e[at + 1] = KINDS.indexOf(event.type);
        e[at + 5] = target;
        if (event.type === "note-on" || event.type === "note-off" || event.type === "note-choke") {
            e[at + 2] = event.key;
            e[at + 3] = event.velocity;
            e[at + 4] = event.channel ?? 0;
        } else if (event.type === "expression") {
            e[at + 2] = event.key;
            e[at + 3] = event.value;
            e[at + 4] = event.channel ?? -1;
            e[at + 6] = event.expression;
        } else if (event.type === "param-mod") {
            e[at + 2] = event.id;
            e[at + 3] = event.value;
            e[at + 4] = event.channel ?? -1;
            e[at + 6] = event.key ?? -1;
        } else if (event.type === "param") {
            e[at + 2] = event.id;
            e[at + 3] = event.value;
        } else if (event.type === "gesture-begin" || event.type === "gesture-end") {
            e[at + 2] = event.id;
        }
        Atomics.store(this.#indices, 0, next);
        return true;
    }

    // Reader side, decoded: each waiting event with its frame and target, in one object reused for every call.
    drain(take: (frame: number, event: Readonly<Event> & { target: number }) => void): void {
        const event = blank() as Event & { target: number };
        this.read((e, at) => {
            decode(e, at, event as unknown as Record<string, unknown>);
            take(e[at] ?? 0, event);
        });
    }

    // Reader side: hands each waiting entry to `take` (its fields), oldest first.
    read(take: (e: Float64Array, at: number) => void): void {
        let read = Atomics.load(this.#indices, 1);
        const write = Atomics.load(this.#indices, 0);
        while (read !== write) {
            take(this.#entries, read * FIELDS);
            read = (read + 1) % (this.capacity + 1);
        }
        Atomics.store(this.#indices, 1, read);
    }
}

// Fills a reused event object from an entry's fields.
function decode(p: Float64Array, at: number, event: Record<string, unknown>): void {
    const type = KINDS[p[at + 1] ?? 0];
    event.type = type;
    event.noteId = -1;
    if (type === "note-on" || type === "note-off" || type === "note-choke") {
        event.key = p[at + 2];
        event.velocity = p[at + 3];
        event.channel = p[at + 4];
    } else if (type === "expression") {
        event.key = p[at + 2];
        event.value = p[at + 3];
        event.channel = p[at + 4];
        event.expression = p[at + 6];
    } else {
        event.id = p[at + 2];
        event.value = p[at + 3];
        const key = p[at + 6] ?? -1;
        event.key = key >= 0 ? key : undefined;
        event.channel = p[at + 4];
    }
    event.target = p[at + 5];
}

// Every field of every kind, so a reused object keeps one shape.
function blank(): Event {
    return {
        at: 0,
        type: "note-on",
        key: 0,
        velocity: 0,
        channel: 0,
        id: 0,
        value: 0,
        expression: 0,
        noteId: -1,
        target: -1,
    } as Event;
}

// The audio side: events from the queue, held in time order, handed out block by block.
//
// Each note-on handed out gets a note ID of its own, and the note-off that ends it the same ID. A note-off names only
// its key and channel, so it ends the oldest note still held on that key and channel for the same plug-in: two
// note-ons on one key, then two note-offs, end the first note and then the second. A note-off with nothing held to
// match (or with CLAP's -1 for its key or channel) goes without an ID, which ends every voice it matches; so does a
// choke, which stops every note held on its key and channel. A plug-in's NOTE_END doesn't change this: the page's
// note-off still comes, and pairs with its note-on as before.
export class Scheduler {
    readonly #queue: EventQueue;
    readonly #pending: Float64Array;
    #count = 0;
    readonly #pool: Event[];
    readonly #take = (e: Float64Array, at: number) => this.#insert(e, at);
    readonly #result: { events: readonly Event[]; count: number };
    readonly #held = new HeldNotes();
    #nextId = 0;
    late = 0;
    dropped = 0;

    constructor(queue: EventQueue, capacity = 1024) {
        this.#queue = queue;
        this.#pending = new Float64Array(capacity * FIELDS);
        // Every field of every kind, so the objects keep one shape as they are reused.
        this.#pool = Array.from({ length: capacity }, blank);
        this.#result = { events: this.#pool, count: 0 };
    }

    get capacity(): number {
        return this.#pool.length;
    }

    // After an event with the same frame, so equal frames keep their order.
    #insert(e: Float64Array, at: number): void {
        if (this.#count === this.#pool.length) {
            this.dropped++;
            // A lost note-off leaves a note hanging: make room by dropping the latest event that isn't one.
            if (!ends(e[at + 1])) return;
            let victim = this.#count - 1;
            while (victim >= 0 && ends(this.#pending[victim * FIELDS + 1])) victim--;
            if (victim < 0) return;
            this.#pending.copyWithin(victim * FIELDS, (victim + 1) * FIELDS, this.#count * FIELDS);
            this.#count--;
        }
        const frame = e[at] ?? 0;
        let i = this.#count;
        while (i > 0 && (this.#pending[(i - 1) * FIELDS] ?? 0) > frame) i--;
        this.#pending.copyWithin((i + 1) * FIELDS, i * FIELDS, this.#count * FIELDS);
        for (let f = 0; f < FIELDS; f++) this.#pending[i * FIELDS + f] = e[at + f] ?? 0;
        this.#count++;
    }

    // The events due in the block starting at `blockStart`, at their frame within it (late ones at 0), in time
    // order. The array and its events are reused by the next call.
    take(blockStart: number, frames: number, max = MAX_EVENTS): { events: readonly Event[]; count: number } {
        this.#queue.read(this.#take);
        const p = this.#pending;
        let n = 0;
        while (n < this.#count && n < max && (p[n * FIELDS] ?? 0) < blockStart + frames) {
            const at = n * FIELDS;
            const offset = (p[at] ?? 0) - blockStart;
            if (offset < 0) this.late++;
            const event = this.#pool[n] as Record<string, unknown>;
            event.at = Math.max(0, Math.floor(offset));
            decode(p, at, event);
            this.#noteId(event as Event);
            n++;
        }
        p.copyWithin(0, n * FIELDS, this.#count * FIELDS);
        this.#count -= n;
        this.#result.count = n;
        return this.#result;
    }

    #noteId(e: Event): void {
        if (e.type !== "note-on" && e.type !== "note-off" && e.type !== "note-choke") return;
        const channel = e.channel ?? 0;
        const target = e.target ?? -1;
        if (e.type === "note-on") {
            if (channel < 0 || e.key < 0) return;
            e.noteId = this.#nextId;
            this.#nextId = this.#nextId === MAX_NOTE_ID ? 0 : this.#nextId + 1;
            this.#held.on(channel, e.key, e.noteId, target);
        } else if (e.type === "note-off" && channel >= 0 && e.key >= 0)
            e.noteId = this.#held.takeOldest(channel, e.key, target);
        else this.#held.off(channel, e.key, -1, target);
    }
}
