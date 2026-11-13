// A mixer as your own arrangement of plug-ins: tracks (each a chain), buses fed by sends, and latency compensation
// to the sample. Registered by graph-worklet.ts; tested in test/mixer.test.ts.
//
// Timing: each source track is delayed to line up with the slowest before anything leaves it, so sends reach the
// buses together; on the way to the master, the sources wait for the slowest bus and each bus for the others, so
// the dry and the wet arrive together too.
import { type Audio, Chain, type HostContext, type Slot, type Topology } from "../src/worklet-api.ts";

export interface Routing {
    // One per track: its plug-ins in order, its level, whether it's a bus (fed by sends rather than notes), and
    // whether it takes notes addressed to no plug-in (live playing; the first source track if none says so).
    tracks: { plugins: number[]; gain: number; bus?: boolean; input?: boolean }[];
    // From a source track to a bus.
    sends: { from: number; to: number; gain: number }[];
    // Each track's latency in frames: the sum over its plug-ins that are playing (not bypassed).
    latency: number[];
}

// Or just new levels, without rerouting.
export interface Levels {
    levels: true;
    gains: number[];
    sends: number[];
}

const FRAMES = 128;
export const MAX_DELAY = 48000;

// A delay line, two channels, reused across reroutes.
class Line {
    readonly buffers = [new Float32Array(MAX_DELAY), new Float32Array(MAX_DELAY)];
    readonly out = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
    delay = 0;
    #at = 0;

    // `from` delayed by `delay` frames, into `out`.
    run(from: readonly Float32Array[], frames: number): void {
        for (let c = 0; c < 2; c++) {
            const line = this.buffers[c] as Float32Array;
            const source = (from[c] ?? from[0]) as Float32Array | undefined;
            const to = this.out[c] as Float32Array;
            let at = this.#at;
            for (let k = 0; k < frames; k++) {
                line[at] = source?.[k] ?? 0;
                to[k] = line[(at - this.delay + MAX_DELAY) % MAX_DELAY] ?? 0;
                at = (at + 1) % MAX_DELAY;
            }
        }
        this.#at = (this.#at + frames) % MAX_DELAY;
    }
}

class Track {
    chain: Chain;
    readonly out = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]];
    readonly input = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]];
    // Before sends (sources line up with each other), and on the way to the master (dry and wet line up).
    readonly toSends = new Line();
    readonly toMaster = new Line();
    gain = 1;
    bus = false;

    constructor(chain: Chain) {
        this.chain = chain;
    }
}

export class Mixer implements Topology {
    readonly #host: HostContext;
    readonly #slots = new Map<number, Slot>();
    readonly #tracks: Track[] = [];
    #count = 0;
    #sends: Routing["sends"] = [];
    readonly #silence: Audio = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]];

    constructor(host: HostContext) {
        this.#host = host;
    }

    add(slot: Slot): void {
        this.#slots.set(slot.id, slot);
    }

    remove(id: number): void {
        this.#slots.delete(id);
        for (const t of this.#tracks) t.chain.remove(id);
    }

    // The host bypassed it; the plug-ins after it on its track let go of their notes.
    setEnabled(id: number, enabled: boolean): void {
        for (let i = 0; i < this.#count; i++) this.#tracks[i]?.chain.setEnabled(id, enabled);
    }

    // A routing reuses the tracks it has (and their delay lines); only the plug-ins and settings change. Between
    // blocks, so the few allocations when tracks are added are fine.
    message(data: unknown): void {
        if ((data as Levels).levels) {
            this.#levels(data as Levels);
            return;
        }
        const routing = data as Routing;
        const inputTrack = Math.max(
            0,
            routing.tracks.findIndex((t) => t.input),
            routing.tracks.findIndex((t) => !t.bus && routing.tracks.every((u) => !u.input)),
        );
        routing.tracks.forEach((spec, i) => {
            const takesUntargeted = i === inputTrack;
            let track = this.#tracks[i];
            if (!track || track.chain.takesUntargeted !== takesUntargeted) {
                const chain = Chain.fromHost(this.#host, { takesUntargeted });
                if (track) for (const slot of [...track.chain.slots]) track.chain.remove(slot.id);
                if (track) track.chain = chain;
                else this.#tracks[i] = track = new Track(chain);
            }
            const ids = spec.plugins;
            for (const slot of [...track.chain.slots]) if (!ids.includes(slot.id)) track.chain.remove(slot.id);
            ids.forEach((id, k) => {
                const slot = this.#slots.get(id);
                if (!slot) return;
                if (track.chain.slots[k]?.id === id) return;
                track.chain.remove(id);
                track.chain.add(slot, k);
            });
            track.gain = spec.gain;
            track.bus = spec.bus ?? false;
        });
        for (let i = routing.tracks.length; i < this.#count; i++) {
            const track = this.#tracks[i];
            if (track) for (const slot of [...track.chain.slots]) track.chain.remove(slot.id);
        }
        this.#count = routing.tracks.length;
        // Only from a source to a bus; a bus feeding a bus would need an order between buses.
        this.#sends = routing.sends
            .filter((s) => !routing.tracks[s.from]?.bus && routing.tracks[s.to]?.bus)
            .map((s) => ({ ...s }));
        const latency = (i: number) => Math.max(0, routing.latency[i] ?? 0);
        let slowestSource = 0;
        let slowestBus = 0;
        routing.tracks.forEach((t, i) => {
            if (t.bus) slowestBus = Math.max(slowestBus, latency(i));
            else slowestSource = Math.max(slowestSource, latency(i));
        });
        routing.tracks.forEach((t, i) => {
            const track = this.#tracks[i] as Track;
            track.toSends.delay = t.bus ? 0 : clamp(slowestSource - latency(i));
            track.toMaster.delay = clamp(t.bus ? slowestBus - latency(i) : slowestBus);
        });
    }

    #levels(levels: Levels): void {
        levels.gains.forEach((g, i) => {
            const t = this.#tracks[i];
            if (t) t.gain = g;
        });
        levels.sends.forEach((g, i) => {
            const s = this.#sends[i];
            if (s) s.gain = g;
        });
    }

    render(blockStart: number, frames: number, _inputs: Audio, outputs: Audio): void {
        // Sources first, lined up; then each bus from its sends.
        for (let i = 0; i < this.#count; i++) {
            const t = this.#tracks[i];
            if (!t || t.bus) continue;
            t.chain.render(blockStart, frames, this.#silence, t.out);
            t.toSends.run(t.out[0] ?? [], frames);
            t.toMaster.run(t.toSends.out, frames);
        }
        for (let b = 0; b < this.#count; b++) {
            const bus = this.#tracks[b];
            if (!bus?.bus) continue;
            const input = bus.input[0] ?? [];
            for (const channel of input) channel.fill(0);
            for (const send of this.#sends) {
                if (send.to !== b) continue;
                const from = this.#tracks[send.from]?.toSends.out ?? [];
                for (let c = 0; c < 2; c++) {
                    const to = input[c] as Float32Array;
                    const source = from[c] as Float32Array;
                    for (let k = 0; k < frames; k++) to[k] = (to[k] ?? 0) + (source[k] ?? 0) * send.gain;
                }
            }
            bus.chain.render(blockStart, frames, bus.input, bus.out);
            bus.toMaster.run(bus.out[0] ?? [], frames);
        }
        const out = outputs[0] ?? [];
        for (const channel of out) channel.fill(0);
        for (let i = 0; i < this.#count; i++) {
            const t = this.#tracks[i];
            if (!t) continue;
            for (let c = 0; c < out.length; c++) {
                const to = out[c] as Float32Array;
                const source = t.toMaster.out[c] ?? t.toMaster.out[0];
                if (source) for (let k = 0; k < frames; k++) to[k] = (to[k] ?? 0) + (source[k] ?? 0) * t.gain;
            }
        }
    }
}

const clamp = (frames: number) => Math.min(MAX_DELAY - 1, Math.max(0, Math.round(frames)));
