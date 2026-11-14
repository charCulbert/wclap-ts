// The notes held, each with its note ID, oldest first, in fixed tables: nothing is allocated once it's made. The
// scheduler keeps one to give a note-off the ID of the note-on it ends, and the runner one per plug-in, to let go of
// what each holds. `target` tells apart notes for different plug-ins (the scheduler's); the runner leaves it 0.
export class HeldNotes {
    readonly #targets: Int32Array;
    // channel * 128 + key
    readonly #notes: Int32Array;
    readonly #ids: Int32Array;
    #count = 0;
    // A note was forgotten to make room: only an any-key note-off can be sure of letting go of everything.
    lost = false;

    constructor(capacity = 2048) {
        this.#targets = new Int32Array(capacity);
        this.#notes = new Int32Array(capacity);
        this.#ids = new Int32Array(capacity);
    }

    get count(): number {
        return this.#count;
    }
    key(i: number): number {
        return (this.#notes[i] ?? 0) % 128;
    }
    channel(i: number): number {
        return Math.floor((this.#notes[i] ?? 0) / 128);
    }
    id(i: number): number {
        return this.#ids[i] ?? -1;
    }

    // A note-on, which must name its channel and key. When the table is full the oldest note is forgotten.
    on(channel: number, key: number, id: number, target = 0): void {
        if (channel < 0 || key < 0) return;
        if (this.#count === this.#ids.length) {
            this.#removeAt(0);
            this.lost = true;
        }
        const i = this.#count++;
        this.#targets[i] = target;
        this.#notes[i] = channel * 128 + key;
        this.#ids[i] = id;
    }

    // The ID of the oldest note held on this channel and key, which is let go; -1 if none is.
    takeOldest(channel: number, key: number, target = 0): number {
        const note = channel * 128 + key;
        for (let i = 0; i < this.#count; i++)
            if (this.#notes[i] === note && this.#targets[i] === target) {
                const id = this.#ids[i] ?? -1;
                this.#removeAt(i);
                return id;
            }
        return -1;
    }

    // Lets go of every note a note-off, choke or NOTE_END matches, by CLAP's rule: each of its ID, channel and key
    // that isn't -1 must be the note's.
    off(channel: number, key: number, id: number, target = 0): void {
        let n = 0;
        for (let i = 0; i < this.#count; i++) {
            const note = this.#notes[i] ?? 0;
            const match =
                this.#targets[i] === target &&
                (id < 0 || this.#ids[i] === id) &&
                (channel < 0 || Math.floor(note / 128) === channel) &&
                (key < 0 || note % 128 === key);
            if (match) continue;
            this.#targets[n] = this.#targets[i] ?? 0;
            this.#notes[n] = note;
            this.#ids[n] = this.#ids[i] ?? -1;
            n++;
        }
        this.#count = n;
        if (channel < 0 && key < 0 && id < 0) this.lost = false;
    }

    // Lets go of the oldest `n` notes.
    drop(n: number): void {
        const k = Math.min(n, this.#count);
        this.#targets.copyWithin(0, k, this.#count);
        this.#notes.copyWithin(0, k, this.#count);
        this.#ids.copyWithin(0, k, this.#count);
        this.#count -= k;
    }

    #removeAt(i: number): void {
        this.#targets.copyWithin(i, i + 1, this.#count);
        this.#notes.copyWithin(i, i + 1, this.#count);
        this.#ids.copyWithin(i, i + 1, this.#count);
        this.#count--;
    }
}
