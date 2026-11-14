// The transport on the audio thread: where the song is at each block's start, and every change inside the block on
// its frame (a tempo or signature point, the loop wrapping, a change the page made). Every host following one page
// Transport works it out the same way from the same anchors, so they agree to the frame.

import { type Loop, type TempoMap, Timeline } from "../events/timeline.ts";
import type { Transport } from "../plugin/plugin-types.ts";

// Where the song is at `frame`, and how it moves from there: what the page sends.
export interface TransportAnchor {
    frame: number;
    beats: number;
    playing: boolean;
    map: TempoMap;
    loop: Loop | null;
}

type Queued = { anchor: TransportAnchor; timeline: Timeline };

const MAX_CHANGES = 8;
const [ANCHOR, POINT, LOOP] = [0, 1, 2];

export class TransportClock {
    readonly transport: Transport;
    readonly sampleRate: number;
    readonly #queue: Queued[] = [];
    // At #frame (fractional after a loop wraps) the song was at #beats, #seconds.
    #frame = 0;
    #beats = 0;
    #seconds = 0;
    #playing = true;
    #timeline = new Timeline();
    #loop: Loop | null = null;

    constructor(sampleRate: number, transport: Transport = { tempo: 120, playing: true, beats: 0 }) {
        this.sampleRate = sampleRate;
        this.transport = transport;
        transport.changes = Array.from({ length: MAX_CHANGES }, () => ({ at: 0, tempo: 120, playing: true, beats: 0 }));
        transport.changeCount = 0;
    }

    // In frame order: the page sends changes as they're made, each at or after the last. The map is built here, not
    // on each block.
    push(anchor: TransportAnchor): void {
        this.#queue.push({ anchor, timeline: new Timeline(anchor.map) });
    }

    #apply({ anchor, timeline }: Queued): void {
        this.#frame = anchor.frame;
        this.#beats = anchor.beats;
        this.#playing = anchor.playing;
        this.#timeline = timeline;
        this.#seconds = timeline.secondsAt(anchor.beats);
        this.#loop = anchor.loop;
    }

    #beatsAt(frame: number): number {
        if (!this.#playing) return this.#beats;
        return this.#timeline.beatsAt(this.#seconds + (frame - this.#frame) / this.sampleRate);
    }

    #frameOf(beats: number): number {
        return this.#frame + (this.#timeline.secondsAt(beats) - this.#seconds) * this.sampleRate;
    }

    #fill(t: Transport, frame: number): void {
        const tl = this.#timeline;
        const beats = this.#beatsAt(frame);
        const { numerator, denominator } = tl.signatureAt(beats);
        t.beats = beats;
        t.seconds = tl.secondsAt(beats);
        t.tempo = tl.tempoAt(beats);
        t.tempoInc = this.#playing ? tl.slopeAt(beats) / this.sampleRate : 0;
        t.playing = this.#playing;
        t.numerator = numerator;
        t.denominator = denominator;
        t.bar = tl.barAt(beats);
        t.barStart = tl.barStartAt(beats);
        const loop = this.#loop;
        t.looping = loop !== null;
        t.loopStart = loop?.startBeat ?? 0;
        t.loopEnd = loop?.endBeat ?? 0;
        t.loopStartSeconds = loop ? tl.secondsAt(loop.startBeat) : 0;
        t.loopEndSeconds = loop ? tl.secondsAt(loop.endBeat) : 0;
    }

    // Fills `transport` for the block of `frames` from `frame`.
    block(frame: number, frames: number): void {
        while ((this.#queue[0]?.anchor.frame ?? Number.POSITIVE_INFINITY) <= frame)
            this.#apply(this.#queue.shift() as Queued);
        const t = this.transport;
        this.#fill(t, frame);
        const changes = t.changes ?? [];
        let count = 0;
        let at = frame;
        const end = frame + frames;
        // Bounded, for a loop shorter than a frame.
        for (let step = 0; step < 64; step++) {
            let next = this.#queue[0]?.anchor.frame ?? Number.POSITIVE_INFINITY;
            let kind = ANCHOR;
            if (this.#playing) {
                const beats = this.#beatsAt(at);
                const point = this.#timeline.nextPoint(beats);
                if (Number.isFinite(point) && this.#frameOf(point) < next) {
                    next = this.#frameOf(point);
                    kind = POINT;
                }
                const loop = this.#loop;
                if (loop && beats < loop.endBeat && this.#frameOf(loop.endBeat) <= next) {
                    next = this.#frameOf(loop.endBeat);
                    kind = LOOP;
                }
            }
            const change = Math.max(at, Math.ceil(next));
            if (!(change < end)) break;
            if (kind === ANCHOR) {
                while ((this.#queue[0]?.anchor.frame ?? Number.POSITIVE_INFINITY) <= change)
                    this.#apply(this.#queue.shift() as Queued);
            } else if (kind === LOOP && this.#loop) {
                this.#frame = next;
                this.#beats = this.#loop.startBeat;
                this.#seconds = this.#timeline.secondsAt(this.#beats);
            }
            // Changes on one frame make one transport event.
            const last = changes[count - 1];
            const slot =
                last && last.at === change - frame ? last : count < changes.length ? changes[count++] : undefined;
            if (slot) {
                slot.at = change - frame;
                this.#fill(slot, change);
            }
            at = change;
        }
        t.changeCount = count;
    }
}
