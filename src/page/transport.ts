// The transport that host-synced plug-ins (arpeggiators, synced delays) follow: play/stop, song position, a tempo
// map with time signatures, and a loop. Hosts on one AudioContext can share one, and then agree to the frame: a
// change takes effect on a frame a few milliseconds ahead (or the frame of the time asked for), and every host works
// out where the song is from the same anchor (where it was at that frame) rather than counting its own blocks.

import { type Loop, type TempoMap, Timeline } from "../events/timeline.ts";
import type { TransportAnchor } from "../worklet/transport-clock.ts";

export type { TransportAnchor };

// Seconds ahead a change is scheduled, so it reaches every host before its frame.
const LEAD = 0.01;

export interface TransportOptions {
    tempo?: number;
    playing?: boolean;
    numerator?: number;
    denominator?: number;
    // In place of tempo and the signature.
    map?: TempoMap;
}

export class Transport {
    readonly context: BaseAudioContext;
    #anchor: TransportAnchor;
    #timeline: Timeline;
    readonly #hosts = new Set<(anchor: TransportAnchor) => void>();

    constructor(context: BaseAudioContext, options: TransportOptions = {}) {
        this.context = context;
        const map = options.map ?? {
            tempos: [{ beat: 0, bpm: options.tempo ?? 120 }],
            signatures: [{ beat: 0, numerator: options.numerator ?? 4, denominator: options.denominator ?? 4 }],
        };
        this.#timeline = new Timeline(map);
        this.#anchor = {
            frame: Math.floor(context.currentTime * context.sampleRate),
            beats: 0,
            playing: options.playing ?? true,
            map,
            loop: null,
        };
    }

    // The tempo now, or as just set if that's still to land. Setting it changes the tempo from the song's position
    // on, keeping the map before it.
    get tempo(): number {
        const c = this.context;
        return this.#timeline.tempoAt(this.#at(Math.max(c.currentTime * c.sampleRate, this.#anchor.frame)));
    }
    set tempo(bpm: number) {
        const frame = this.#frame();
        const beat = this.#at(frame);
        const tempos = this.#anchor.map.tempos.filter((t) => t.beat < beat);
        this.#change({ map: { ...this.#anchor.map, tempos: [...tempos, { beat, bpm }] } }, frame);
    }
    get playing(): boolean {
        return this.#anchor.playing;
    }
    set playing(on: boolean) {
        this.#change({ playing: on });
    }
    // Starts or stops at an AudioContext time (now if left out), on its frame.
    play(when?: number): void {
        this.#change({ playing: true }, this.#frame(when));
    }
    stop(when?: number): void {
        this.#change({ playing: false }, this.#frame(when));
    }
    // One time signature for the whole song: bars count from beat 0.
    setTimeSignature(numerator: number, denominator: number): void {
        this.#change({ map: { ...this.#anchor.map, signatures: [{ beat: 0, numerator, denominator }] } });
    }
    // Replaces the whole tempo map; the song keeps its position in beats.
    setMap(map: TempoMap, when?: number): void {
        this.#change({ map }, this.#frame(when));
    }
    get map(): TempoMap {
        return this.#anchor.map;
    }
    // Loops from startBeat to endBeat while playing, wrapping on the frame; null for none.
    setLoop(loop: Loop | null, when?: number): void {
        if (loop && !(loop.endBeat > loop.startBeat)) throw new Error("a loop ends after it starts");
        this.#change({ loop }, this.#frame(when));
    }
    get loop(): Loop | null {
        return this.#anchor.loop;
    }
    // Moves the song position, in quarter notes.
    seek(beats: number, when?: number): void {
        this.#change({ beats }, this.#frame(when));
    }
    // The song position now, in quarter notes.
    get beats(): number {
        return this.#at(this.context.currentTime * this.context.sampleRate);
    }

    /** @internal A host follows this transport until the returned function is called. */
    follow(send: (anchor: TransportAnchor) => void): () => void {
        this.#hosts.add(send);
        send(this.#anchor);
        return () => this.#hosts.delete(send);
    }

    // The frame of `when`, or a few milliseconds ahead of now; never before now's lead or the last change.
    #frame(when?: number): number {
        const c = this.context;
        const soonest = Math.ceil((c.currentTime + LEAD) * c.sampleRate);
        const at = when === undefined ? soonest : Math.max(soonest, Math.round(when * c.sampleRate));
        return Math.max(this.#anchor.frame, at);
    }

    // Where the song is at `frame`, from the anchor, wrapping in the loop as the audio side does.
    #at(frame: number): number {
        const a = this.#anchor;
        const tl = this.#timeline;
        if (!a.playing) return a.beats;
        const start = tl.secondsAt(a.beats);
        let seconds = start + Math.max(0, frame - a.frame) / this.context.sampleRate;
        const loop = a.loop;
        if (loop && a.beats < loop.endBeat) {
            const end = tl.secondsAt(loop.endBeat);
            if (seconds >= end) {
                const from = tl.secondsAt(loop.startBeat);
                seconds = from + ((seconds - end) % (end - from));
            }
        }
        return tl.beatsAt(seconds);
    }

    #change(change: Partial<TransportAnchor>, frame = this.#frame()): void {
        this.#anchor = { ...this.#anchor, beats: this.#at(frame), ...change, frame };
        if (change.map) this.#timeline = new Timeline(change.map);
        for (const send of this.#hosts) send(this.#anchor);
    }
}

export function createTransport(context: BaseAudioContext, options?: TransportOptions): Transport {
    return new Transport(context, options);
}
