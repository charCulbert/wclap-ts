// One plug-in's block, whatever arrangement it's in (a chain, your own graph): bypass and failure, letting go of held
// notes, parameter changes flushed while bypassed, main-thread time, reset and a one-block fade when it's bypassed or
// brought back. Allocates nothing per block.
import { MAX_EVENTS, type OutputList } from "../plugin/clap-host-callbacks.ts";
import type { Event, Ports, Transport } from "../plugin/plugin-types.ts";

export type Audio = readonly (readonly Float32Array[])[];

// One plug-in's audio role: the whole plug-in on one thread, or the audio half of one on two. `process` returns
// null while the plug-in isn't processing (stopped for a restart, or on its way out).
export interface Processor {
    process(frames: number, events: readonly Event[], inputs: Audio, count: number, transport: Transport): Audio | null;
    // Parameter events for a plug-in that isn't processed this block; its own changes come back in `output`.
    flush?(events: readonly Event[], count: number): void;
    // Work owed while it isn't processed: main-thread work on this thread, or a stop the main side asked for.
    idle?(): void;
    // Clears its buffers and voices, as when brought back from bypass.
    reset?(): void;
    readonly output: OutputList;
}

export interface Slot {
    id: number;
    processor: Processor;
    ports: Ports;
    enabled: boolean;
    failed: boolean;
}

// Room kept for note-offs when a block's events reach the limit, so no note is left hanging.
export const NOTE_OFF_ROOM = 64;
const NOTES = 16 * 128;
const FADE_CHANNELS = 8;
const MAX_FRAMES = 128;

export class Runner {
    readonly transport: Transport;
    // A plug-in trapped: it's marked failed and silent from then on.
    onFailure: (id: number, error: unknown) => void = () => undefined;
    // A plug-in changed its own parameters, or began or ended a gesture: those events are in `out`.
    onParams: (id: number, out: OutputList) => void = () => undefined;
    // Whether the last run processed the plug-in, so its output notes in `processor.output` are this block's.
    processed = false;
    readonly #events: Event[] = [];
    readonly #releases: Event[] = Array.from({ length: MAX_EVENTS }, () => noteOff());
    readonly #held = new Map<number, Uint8Array>();
    readonly #release = new Set<number>();
    readonly #fade = new Map<number, "in" | "out">();
    readonly #fadeBuffers = Array.from({ length: FADE_CHANNELS }, () => new Float32Array(MAX_FRAMES));
    readonly #fadePort: Float32Array[] = [];
    readonly #fadeAudio: Float32Array[][] = [];
    // Plug-ins run this block, so the host can look after the rest.
    readonly #ran = new Set<number>();
    readonly #own: Event[] = [];

    constructor(transport: Transport) {
        this.transport = transport;
    }

    add(id: number): void {
        if (!this.#held.has(id)) this.#held.set(id, new Uint8Array(NOTES));
    }

    remove(id: number): void {
        this.#held.delete(id);
        this.#release.delete(id);
        this.#fade.delete(id);
    }

    // Before its next block, the plug-in lets go of every note it holds (its note-offs may no longer reach it).
    release(id: number): void {
        this.#release.add(id);
    }

    // Bypass or bring back; it lets go of its notes, and fades over its next block.
    setEnabled(slot: Slot, enabled: boolean): void {
        if (slot.enabled === enabled) return;
        slot.enabled = enabled;
        this.#fade.set(slot.id, enabled ? "in" : "out");
        this.#release.add(slot.id);
    }

    // The plug-in's block: `events` are its own, in time order. Returns its audio, or null to pass `inputs` on
    // unchanged (failed, bypassed, not processing). `processed` says whether its output events are this block's.
    run(slot: Slot, frames: number, inputs: Audio, events: readonly Event[], count: number): Audio | null {
        this.processed = false;
        this.#ran.add(slot.id);
        const fade = this.#fade.get(slot.id);
        if (fade) this.#fade.delete(slot.id);
        if (slot.failed) return null;
        const releases = this.#release.has(slot.id) ? this.#takeReleases(slot.id) : 0;
        const p = slot.processor;
        try {
            if (!slot.enabled) {
                // Bypassed: its let-go notes still reach it (its sound fading out over this block), parameters
                // reach it by flush, and it still gets main-thread time and its stop handshake.
                let out: Audio | null = null;
                if (releases || fade === "out") {
                    const wet = p.process(frames, this.#events, inputs, releases, this.transport);
                    if (wet && fade === "out") out = this.#crossfade(inputs, wet, frames, false);
                }
                p.idle?.();
                p.flush?.(events, count);
                if (p.output.count) this.onParams(slot.id, p.output);
                return out;
            }
            let n = releases;
            for (let k = 0; k < count; k++) {
                const e = events[k];
                if (e && fits(e, n)) this.#events[n++] = e;
            }
            // Back from bypass: clear what it was holding (delay lines, envelopes) before fading in.
            if (fade === "in") p.reset?.();
            const rendered = p.process(frames, this.#events, inputs, n, this.transport);
            this.#hold(slot.id, n);
            p.idle?.();
            if (!rendered) return null;
            this.processed = true;
            const out = p.output;
            for (let k = 0; k < out.count; k++) {
                const t = out.events[k]?.type;
                if (t === "param" || t === "gesture-begin" || t === "gesture-end") {
                    this.onParams(slot.id, out);
                    break;
                }
            }
            if (slot.ports.outputs.length === 0) return null;
            return fade === "in" ? this.#crossfade(inputs, rendered, frames, true) : rendered;
        } catch (error) {
            slot.failed = true;
            this.onFailure(slot.id, error);
            return null;
        }
    }

    // The host's side of each block: before it, forget who ran; after it, every plug-in the arrangement didn't run
    // (not routed anywhere yet) still gets its main-thread time, its stop handshake and its parameter changes, so
    // it can be removed, restarted or set up before it's routed.
    beginBlock(): void {
        this.#ran.clear();
    }

    endBlock(slots: Iterable<Slot>, events: readonly Event[], count: number): void {
        for (const slot of slots) {
            if (this.#ran.has(slot.id) || slot.failed) continue;
            let n = 0;
            for (let k = 0; k < count; k++) {
                const e = events[k];
                if (e && e.target === slot.id && (e.type === "param" || e.type === "param-mod")) this.#own[n++] = e;
            }
            try {
                slot.processor.idle?.();
                slot.processor.flush?.(this.#own, n);
                if (slot.processor.output.count) this.onParams(slot.id, slot.processor.output);
            } catch (error) {
                slot.failed = true;
                this.onFailure(slot.id, error);
            }
        }
    }

    // Mixes from `from` to `to` across the block (or back, when not `rising`): a switch without a click. Only the
    // main port fades; the buffers are the runner's own.
    #crossfade(from: Audio, to: Audio, frames: number, rising: boolean): Audio {
        const port = to[0] ?? [];
        const dry = from[0] ?? [];
        const channels = Math.min(Math.max(port.length, dry.length), FADE_CHANNELS);
        const mixed = this.#fadePort;
        mixed.length = channels;
        for (let c = 0; c < channels; c++) {
            const wet = port[c] ?? (port.length === 1 ? port[0] : undefined);
            const source = dry[c] ?? (dry.length === 1 ? dry[0] : undefined);
            const mix = this.#fadeBuffers[c] as Float32Array;
            for (let k = 0; k < frames; k++) {
                const g = rising ? k / frames : 1 - k / frames;
                mix[k] = (wet?.[k] ?? 0) * g + (source?.[k] ?? 0) * (1 - g);
            }
            mixed[c] = mix;
        }
        this.#fadeAudio.length = to.length || 1;
        this.#fadeAudio[0] = mixed;
        for (let p = 1; p < to.length; p++) this.#fadeAudio[p] = to[p] as Float32Array[];
        return this.#fadeAudio;
    }

    // Note-offs, at the block's start, for the notes this plug-in holds; the rest wait for the next block.
    #takeReleases(id: number): number {
        const held = this.#held.get(id);
        let n = 0;
        if (held)
            for (let k = 0; k < NOTES && n < MAX_EVENTS - NOTE_OFF_ROOM; k++) {
                if (!held[k]) continue;
                held[k] = 0;
                const e = this.#releases[n] as { key: number; channel: number };
                e.key = k % 128;
                e.channel = Math.floor(k / 128);
                this.#events[n] = this.#releases[n] as Event;
                n++;
            }
        if (n < MAX_EVENTS - NOTE_OFF_ROOM) this.#release.delete(id);
        return n;
    }

    #hold(id: number, n: number): void {
        const held = this.#held.get(id);
        if (!held) return;
        for (let k = 0; k < n; k++) {
            const e = this.#events[k];
            if (e?.type === "note-on" || e?.type === "note-off")
                mark(held, e.channel ?? 0, e.key, e.type === "note-on");
        }
    }
}

// Past the block's limit, only note-offs still fit, so nothing is left hanging.
export function fits(e: Event, n: number): boolean {
    return n < MAX_EVENTS - NOTE_OFF_ROOM || (e.type === "note-off" && n < MAX_EVENTS);
}

// Marks a note held or let go; -1 for the channel or key (CLAP's "any") lets go of every match.
export function mark(notes: Uint8Array, channel: number, key: number, on: boolean): void {
    if (channel >= 0 && key >= 0) {
        notes[channel * 128 + key] = on ? 1 : 0;
        return;
    }
    if (on) return;
    for (let c = 0; c < 16; c++)
        for (let k = 0; k < 128; k++)
            if ((channel < 0 || c === channel) && (key < 0 || k === key)) notes[c * 128 + k] = 0;
}

export function noteOff(): Event {
    return { at: 0, type: "note-off", key: 0, velocity: 0, channel: 0 };
}
