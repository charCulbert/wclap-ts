// The transport that host-synced plug-ins (arpeggiators, synced delays) follow: tempo, play/stop, time signature and
// song position. Hosts on one AudioContext can share one, and then agree to the frame: a change takes effect at a
// block boundary a few milliseconds ahead, and every host works out its position from the same anchor (where the
// song was at that frame) rather than counting its own blocks.

const BLOCK = 128;
// Seconds ahead a change is scheduled, so it reaches every host before its frame.
const LEAD = 0.01;

// Where the song is at `frame`, and how it moves from there.
export interface TransportAnchor {
    frame: number;
    beats: number;
    seconds: number;
    tempo: number;
    playing: boolean;
    numerator: number;
    denominator: number;
}

export interface TransportOptions {
    tempo?: number;
    playing?: boolean;
    numerator?: number;
    denominator?: number;
}

export class Transport {
    readonly context: BaseAudioContext;
    #anchor: TransportAnchor;
    readonly #hosts = new Set<(anchor: TransportAnchor) => void>();

    constructor(context: BaseAudioContext, options: TransportOptions = {}) {
        this.context = context;
        this.#anchor = {
            frame: Math.floor((context.currentTime * context.sampleRate) / BLOCK) * BLOCK,
            beats: 0,
            seconds: 0,
            tempo: options.tempo ?? 120,
            playing: options.playing ?? true,
            numerator: options.numerator ?? 4,
            denominator: options.denominator ?? 4,
        };
    }

    get tempo(): number {
        return this.#anchor.tempo;
    }
    set tempo(bpm: number) {
        this.#change({ tempo: bpm });
    }
    get playing(): boolean {
        return this.#anchor.playing;
    }
    set playing(on: boolean) {
        this.#change({ playing: on });
    }
    // The bar shape host-synced plug-ins see: 4/4 unless set.
    setTimeSignature(numerator: number, denominator: number): void {
        this.#change({ numerator, denominator });
    }
    // Moves the song position, in quarter notes.
    seek(beats: number): void {
        this.#change({ beats, seconds: (beats * 60) / this.#anchor.tempo });
    }
    // The song position now, in quarter notes.
    get beats(): number {
        return this.#at(this.context.currentTime * this.context.sampleRate).beats;
    }

    /** @internal A host follows this transport until the returned function is called. */
    follow(send: (anchor: TransportAnchor) => void): () => void {
        this.#hosts.add(send);
        send(this.#anchor);
        return () => this.#hosts.delete(send);
    }

    // Where the song is at `frame`, from the anchor.
    #at(frame: number): { beats: number; seconds: number } {
        const a = this.#anchor;
        const elapsed = a.playing ? Math.max(0, frame - a.frame) / this.context.sampleRate : 0;
        return { beats: a.beats + (elapsed * a.tempo) / 60, seconds: a.seconds + elapsed };
    }

    #change(change: Partial<TransportAnchor>): void {
        const c = this.context;
        const frame = Math.max(this.#anchor.frame, Math.ceil(((c.currentTime + LEAD) * c.sampleRate) / BLOCK) * BLOCK);
        this.#anchor = { ...this.#anchor, ...this.#at(frame), ...change, frame };
        for (const send of this.#hosts) send(this.#anchor);
    }
}

export function createTransport(context: BaseAudioContext, options?: TransportOptions): Transport {
    return new Transport(context, options);
}
