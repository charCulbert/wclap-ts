// The song's tempo map and time signatures, and where on it a beat or a second falls. Beats are quarter notes;
// seconds count from beat 0. Before the first tempo the first tempo holds, and before the first signature the first
// signature, so positions before the start work too.

export interface TempoMap {
    // Each tempo holds from its beat to the next one's; with `ramp` it glides to the next one's tempo instead,
    // linearly in time (as CLAP's tempo_inc describes it).
    tempos: { beat: number; bpm: number; ramp?: boolean }[];
    // Bars restart at each signature's beat.
    signatures: { beat: number; numerator: number; denominator: number }[];
}

// From the start beat to the end beat, over and over while the song plays.
export interface Loop {
    startBeat: number;
    endBeat: number;
}

export const DEFAULT_MAP: TempoMap = {
    tempos: [{ beat: 0, bpm: 120 }],
    signatures: [{ beat: 0, numerator: 4, denominator: 4 }],
};

interface Segment {
    beat: number;
    seconds: number;
    bpm: number;
    // Tempo change per second, while it ramps.
    slope: number;
}

interface Bars {
    beat: number;
    numerator: number;
    denominator: number;
    // The bar number at `beat`.
    bar: number;
    length: number;
}

// A tempo map ready to look up: built once per map, then lookups allocate nothing.
export class Timeline {
    readonly map: TempoMap;
    readonly #segments: Segment[] = [];
    readonly #bars: Bars[] = [];

    constructor(map: TempoMap = DEFAULT_MAP) {
        this.map = map;
        const tempos = [...(map.tempos.length ? map.tempos : DEFAULT_MAP.tempos)].sort((a, b) => a.beat - b.beat);
        let seconds = 0;
        for (let i = 0; i < tempos.length; i++) {
            const t = tempos[i] as TempoMap["tempos"][number];
            const next = tempos[i + 1];
            const end = t.ramp && next ? next.bpm : t.bpm;
            const length = next ? next.beat - t.beat : Number.POSITIVE_INFINITY;
            const duration = (120 * length) / (t.bpm + end);
            this.#segments.push({
                beat: t.beat,
                seconds,
                bpm: t.bpm,
                slope: end !== t.bpm ? (end - t.bpm) / duration : 0,
            });
            seconds += duration;
        }
        // Seconds count from beat 0.
        const zero = this.secondsAt(0);
        for (const s of this.#segments) s.seconds -= zero;

        const signatures = [...(map.signatures.length ? map.signatures : DEFAULT_MAP.signatures)].sort(
            (a, b) => a.beat - b.beat,
        );
        let bar = 0;
        for (let i = 0; i < signatures.length; i++) {
            const s = signatures[i] as TempoMap["signatures"][number];
            const length = (s.numerator * 4) / s.denominator;
            this.#bars.push({ ...s, bar, length });
            const next = signatures[i + 1];
            // A signature that starts mid-bar cuts that bar short; it still counts as one.
            if (next) bar += Math.ceil((next.beat - s.beat) / length - 1e-9);
        }
    }

    #segmentAtBeat(beats: number): Segment {
        let k = 0;
        while (k + 1 < this.#segments.length && (this.#segments[k + 1] as Segment).beat <= beats) k++;
        return this.#segments[k] as Segment;
    }

    #segmentAtSeconds(seconds: number): Segment {
        let k = 0;
        while (k + 1 < this.#segments.length && (this.#segments[k + 1] as Segment).seconds <= seconds) k++;
        return this.#segments[k] as Segment;
    }

    // Seconds into a segment at `beats` past its start.
    #elapsed(s: Segment, beats: number): number {
        if (beats < 0 || s.slope === 0) return (60 * beats) / s.bpm;
        return (120 * beats) / (s.bpm + Math.sqrt(s.bpm * s.bpm + 120 * s.slope * beats));
    }

    secondsAt(beats: number): number {
        const s = this.#segmentAtBeat(beats);
        return s.seconds + this.#elapsed(s, beats - s.beat);
    }

    beatsAt(seconds: number): number {
        const s = this.#segmentAtSeconds(seconds);
        const t = seconds - s.seconds;
        if (t < 0) return s.beat + (s.bpm * t) / 60;
        return s.beat + (s.bpm * t + (s.slope * t * t) / 2) / 60;
    }

    tempoAt(beats: number): number {
        const s = this.#segmentAtBeat(beats);
        return beats < s.beat ? s.bpm : s.bpm + s.slope * this.#elapsed(s, beats - s.beat);
    }

    // Tempo change per second at `beats`: not 0 only while ramping.
    slopeAt(beats: number): number {
        const s = this.#segmentAtBeat(beats);
        return beats < s.beat ? 0 : s.slope;
    }

    #barsAt(beats: number): Bars {
        let k = 0;
        while (k + 1 < this.#bars.length && (this.#bars[k + 1] as Bars).beat <= beats) k++;
        return this.#bars[k] as Bars;
    }

    // The bar `beats` is in, counted from 0 at the first signature's beat.
    barAt(beats: number): number {
        const b = this.#barsAt(beats);
        return b.bar + Math.floor((beats - b.beat) / b.length);
    }

    // The beat that bar starts on.
    barStartAt(beats: number): number {
        const b = this.#barsAt(beats);
        return b.beat + Math.floor((beats - b.beat) / b.length) * b.length;
    }

    signatureAt(beats: number): { numerator: number; denominator: number } {
        return this.#barsAt(beats);
    }

    // The first tempo or signature point after `beats`, Infinity if none: where the transport changes on its own.
    nextPoint(beats: number): number {
        let next = Number.POSITIVE_INFINITY;
        for (const s of this.#segments) if (s.beat > beats && s.beat < next) next = s.beat;
        for (const b of this.#bars) if (b.beat > beats && b.beat < next) next = b.beat;
        return next;
    }
}

export function beatsToSeconds(map: TempoMap, beats: number): number {
    return new Timeline(map).secondsAt(beats);
}

export function secondsToBeats(map: TempoMap, seconds: number): number {
    return new Timeline(map).beatsAt(seconds);
}

// The bar `beats` is in (from 0), the beat it starts on, and its signature.
export function barAt(
    map: TempoMap,
    beats: number,
): { bar: number; start: number; numerator: number; denominator: number } {
    const t = new Timeline(map);
    const { numerator, denominator } = t.signatureAt(beats);
    return { bar: t.barAt(beats), start: t.barStartAt(beats), numerator, denominator };
}
