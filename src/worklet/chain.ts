// A chain of plug-ins on the audio side: each block, every plug-in in order, audio and notes passed from one to the
// next inside the block. One arrangement of plug-ins (a Topology); Runner does each plug-in's block.
import { MAX_EVENTS, type OutputList } from "../plugin/clap-host-callbacks.ts";
import type { Event, Transport } from "../plugin/plugin-types.ts";
import { type Audio, fits, mark, noteOff, Runner, type Slot } from "./plugin-runner.ts";
import type { EventSource, HostContext, Topology } from "./topology.ts";

const NOTES = 16 * 128;

// A Chain's own state, or the host's, shared with other chains (a graph's tracks).
export interface ChainSetup {
    runner?: Runner;
    transport?: Transport;
    // Whether the first plug-in takes events addressed to no plug-in (live notes, MIDI in). Default true.
    takesUntargeted?: boolean;
}

export class Chain implements Topology {
    readonly slots: Slot[] = [];
    readonly transport: Transport;
    readonly events: EventSource;
    readonly sampleRate: number;
    readonly runner: Runner;
    onNotesOut: (blockStart: number, notes: readonly Event[], count: number) => void = () => undefined;
    // Events for the plug-in being processed, and the notes on their way to the next one: reused every block.
    readonly #events: Event[] = [];
    readonly #passing: Event[] = [];
    #passingCount = 0;
    // The notes that have left the chain, let go when its end changes.
    readonly #sent = new Uint8Array(NOTES);
    #sentRelease = false;
    readonly #out: Event[] = [];
    readonly #outReleases: Event[] = Array.from({ length: MAX_EVENTS }, () => noteOff());

    readonly #shared: boolean;
    // Whether its first plug-in takes events addressed to no plug-in.
    readonly takesUntargeted: boolean;

    constructor(events: EventSource, sampleRate: number, setup: ChainSetup = {}) {
        this.events = events;
        this.sampleRate = sampleRate;
        this.#shared = setup.runner !== undefined;
        this.transport = setup.transport ?? { tempo: 120, playing: true, beats: 0, seconds: 0 };
        this.runner = setup.runner ?? new Runner(this.transport);
        this.takesUntargeted = setup.takesUntargeted ?? true;
    }

    // A chain on the host's runner, transport and events, sending its notes out through the host.
    static fromHost(host: HostContext, setup: Pick<ChainSetup, "takesUntargeted"> = {}): Chain {
        const chain = new Chain(host.events, host.sampleRate, {
            ...setup,
            runner: host.runner,
            transport: host.transport,
        });
        chain.onNotesOut = (blockStart, notes, count) => host.notesOut(blockStart, notes, count);
        return chain;
    }

    get onFailure(): (id: number, error: unknown) => void {
        return this.runner.onFailure;
    }
    set onFailure(f: (id: number, error: unknown) => void) {
        this.runner.onFailure = f;
    }
    get onParams(): (id: number, out: OutputList) => void {
        return this.runner.onParams;
    }
    set onParams(f: (id: number, out: OutputList) => void) {
        this.runner.onParams = f;
    }

    // A change to the chain reroutes notes from that point on: the plug-ins there let go of the notes they hold,
    // since their note-offs may never reach them by the new route, and so do notes already sent out.
    add(slot: Slot, index = this.slots.length): void {
        const at = Math.max(0, Math.min(index, this.slots.length));
        this.runner.add(slot.id);
        this.slots.splice(at, 0, slot);
        this.#releaseFrom(at + 1);
    }

    remove(id: number): Slot | undefined {
        const i = this.slots.findIndex((s) => s.id === id);
        if (i < 0) return undefined;
        const [slot] = this.slots.splice(i, 1);
        // A shared runner's plug-ins belong to the host, which may route this one somewhere else.
        if (!this.#shared) this.runner.remove(id);
        this.#releaseFrom(i);
        return slot;
    }

    move(id: number, index: number): void {
        const from = this.slots.findIndex((s) => s.id === id);
        const slot = this.slots[from];
        if (!slot) return;
        this.slots.splice(from, 1);
        const at = Math.max(0, Math.min(index, this.slots.length));
        this.slots.splice(at, 0, slot);
        this.#releaseFrom(Math.min(from, at));
    }

    // On its own runner it bypasses the plug-in; on the host's, the host already has. Either way the plug-ins after
    // it let go of their notes, since the route to them changed.
    setEnabled(id: number, enabled: boolean): void {
        const i = this.slots.findIndex((s) => s.id === id);
        const slot = this.slots[i];
        if (!slot) return;
        if (!this.#shared) this.runner.setEnabled(slot, enabled);
        this.#releaseFrom(i + 1);
    }

    seek(beats: number): void {
        this.transport.beats = beats;
        this.transport.seconds = (beats * 60) / this.transport.tempo;
    }

    #releaseFrom(index: number): void {
        for (let i = index; i < this.slots.length; i++) {
            const slot = this.slots[i];
            if (slot) this.runner.release(slot.id);
        }
        this.#sentRelease = true;
    }

    render(blockStart: number, frames: number, inputs: Audio, outputs: Audio): void {
        const { events, count } = this.events.take(blockStart, frames);
        if (!this.#shared) this.transport.frame = blockStart;
        let audio = inputs;
        this.#passingCount = 0;
        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i];
            if (!slot) continue;
            const n = this.#gather(slot, i === 0 && this.takesUntargeted, events, count);
            const rendered = this.runner.run(slot, frames, audio, this.#events, n);
            if (rendered) audio = rendered;
            if (this.runner.processed) this.#passOutput(slot.processor.output);
            else this.#pass(n);
        }
        this.#sendOut(blockStart);
        copyAudio(audio, outputs);
        if (!this.#shared && this.transport.playing) {
            this.transport.beats += (frames / this.sampleRate) * (this.transport.tempo / 60);
            this.transport.seconds = (this.transport.seconds ?? 0) + frames / this.sampleRate;
        }
    }

    // The plug-in's own notes and MIDI go on to the next one, the notes with the note IDs it gave them (its parameter
    // changes went to the page). Its NOTE_ENDs stop here: they answer the note-ons it was sent, and the runner has used them.
    #passOutput(out: OutputList): void {
        this.#passingCount = 0;
        for (let k = 0; k < out.count; k++) {
            const e = out.events[k];
            if (e && passes(e) && this.#passingCount < MAX_EVENTS) this.#passing[this.#passingCount++] = e;
        }
    }

    // The notes and MIDI leaving the chain, after note-offs for notes sent before its end changed.
    #sendOut(blockStart: number): void {
        const list = this.#out;
        let n = 0;
        if (this.#sentRelease) {
            this.#sentRelease = false;
            for (let k = 0; k < NOTES && n < MAX_EVENTS; k++) {
                if (!this.#sent[k]) continue;
                this.#sent[k] = 0;
                n = this.#release(n, 0, Math.floor(k / 128), k % 128);
            }
        }
        for (let k = 0; k < this.#passingCount && n < MAX_EVENTS; k++) {
            const e = this.#passing[k];
            if (e?.type === "midi") {
                list[n++] = e;
                continue;
            }
            if (e?.type !== "note-on" && e?.type !== "note-off" && e?.type !== "note-choke") continue;
            const channel = e.channel ?? 0;
            if (e.type !== "note-choke" && channel >= 0 && e.key >= 0) {
                mark(this.#sent, channel, e.key, e.type === "note-on");
                list[n++] = e;
            } else if (e.type !== "note-on")
                // MIDI has no choke, and nothing like CLAP's -1 for any key or channel: either becomes a note-off
                // for each matching note sent.
                for (let c = 0; c < 16; c++)
                    for (let key = 0; key < 128 && n < MAX_EVENTS; key++) {
                        if ((channel >= 0 && c !== channel) || (e.key >= 0 && key !== e.key)) continue;
                        if (!this.#sent[c * 128 + key]) continue;
                        this.#sent[c * 128 + key] = 0;
                        n = this.#release(n, e.at, c, key);
                    }
        }
        if (n > 0) this.onNotesOut(blockStart, list, n);
    }

    #release(n: number, at: number, channel: number, key: number): number {
        const off = this.#outReleases[n] as { at: number; key: number; channel: number };
        off.at = at;
        off.key = key;
        off.channel = channel;
        this.#out[n] = off as Event;
        return n + 1;
    }

    // This plug-in's events for the block, in time order: notes passed on from the plug-in before it, plus the
    // scheduled events addressed to it (or to the start of the chain, for the first plug-in).
    #gather(slot: Slot, first: boolean, events: readonly Event[], count: number): number {
        const out = this.#events;
        let n = 0;
        let p = 0;
        const passed = this.#passing;
        for (let k = 0; k <= count; k++) {
            const e = k < count ? events[k] : undefined;
            if (e && !(e.target === slot.id || (first && (e.target ?? -1) === -1))) continue;
            while (p < this.#passingCount) {
                const q = passed[p];
                if (!q || (e && q.at > e.at)) break;
                if (fits(q, n)) out[n++] = q;
                p++;
            }
            if (e && fits(e, n)) out[n++] = e;
        }
        return n;
    }

    // A plug-in that's bypassed, failed or not processing passes on the notes and expressions that reached it, both
    // passed down the chain and addressed to it (the bypassed plug-in is as if absent).
    #pass(n: number): void {
        let k = 0;
        for (let i = 0; i < n; i++) {
            const e = this.#events[i];
            if (e && passes(e)) this.#passing[k++] = e;
        }
        this.#passingCount = k;
    }
}

// What goes on from one plug-in to the next: notes, their expressions, and MIDI.
function passes(e: Event): boolean {
    return (
        e.type === "note-on" ||
        e.type === "note-off" ||
        e.type === "note-choke" ||
        e.type === "expression" ||
        e.type === "midi"
    );
}

// Port by port; a mono port feeds every channel of its output, and outputs with no source are silent.
export function copyAudio(from: Audio, to: Audio): void {
    for (let p = 0; p < to.length; p++) {
        const port = to[p] ?? [];
        const source = from[p];
        for (let c = 0; c < port.length; c++) {
            const target = port[c];
            const channel = source?.[c] ?? (source?.length === 1 ? source[0] : undefined);
            if (!target) continue;
            if (channel) target.set(channel.length > target.length ? channel.subarray(0, target.length) : channel);
            else target.fill(0);
        }
    }
}
