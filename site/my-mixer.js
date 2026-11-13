// Your own arrangement of plug-ins, in your own AudioWorklet module: two tracks, a delay bus fed by sends, and each
// track delayed to line up with the slowest. wclap-ts loads the plug-ins, runs their threads, delivers their events
// and handles bypass; this file only decides what feeds what.
//
// AudioWorklet modules can't use import maps, so this imports the library by path (a bundler would do it for you).
import { Chain, registerWclapProcessor } from "/node_modules/wclap-ts/dist/worklet-api.js";

const FRAMES = 128;
const MAX_DELAY = 48000;
const stereo = () => [new Float32Array(FRAMES), new Float32Array(FRAMES)];

class Mixer {
    constructor(host) {
        this.host = host;
        this.slots = new Map();   // every plug-in the page added, by id
        this.tracks = [];
        this.sends = [];
        this.silence = [stereo()];
    }

    add(slot) {
        this.slots.set(slot.id, slot);
    }

    remove(id) {
        this.slots.delete(id);
        for (const t of this.tracks) t.chain.remove(id);
    }

    // From the page: { tracks: [{ plugins: [ids], gain, latency, bus? }], sends: [{ from, to, gain }] } to route,
    // or just { sends } to change send levels without rebuilding anything.
    message(routing) {
        if (!routing.tracks) {
            routing.sends.forEach((s, i) => this.sends[i] && (this.sends[i].gain = s.gain));
            return;
        }
        for (const t of this.tracks) for (const s of [...t.chain.slots]) t.chain.remove(s.id);
        const slowest = Math.max(0, ...routing.tracks.filter((t) => !t.bus).map((t) => t.latency));
        this.tracks = routing.tracks.map((spec, i) => {
            const chain = Chain.fromHost(this.host, { takesUntargeted: i === 0 });
            for (const id of spec.plugins) chain.add(this.slots.get(id));
            return {
                chain,
                gain: spec.gain,
                bus: spec.bus ?? false,
                delay: spec.bus ? 0 : slowest - spec.latency,
                line: [new Float32Array(MAX_DELAY), new Float32Array(MAX_DELAY)],
                at: 0,
                out: [stereo()],
                aligned: stereo(),
                input: [stereo()],
            };
        });
        this.sends = routing.sends.map((s) => ({ ...s }));
    }

    render(blockStart, frames, _inputs, outputs) {
        const master = outputs[0];
        for (const channel of master) channel.fill(0);
        // Sources: render, then delay to line up with the slowest.
        for (const t of this.tracks.filter((t) => !t.bus)) {
            t.chain.render(blockStart, frames, this.silence, t.out);
            for (let c = 0; c < 2; c++)
                for (let k = 0; k < frames; k++) {
                    const at = (t.at + k) % MAX_DELAY;
                    t.line[c][at] = t.out[0][c][k];
                    t.aligned[c][k] = t.line[c][(at - t.delay + MAX_DELAY) % MAX_DELAY];
                }
            t.at = (t.at + frames) % MAX_DELAY;
        }
        // Buses: the sum of their sends, through their own plug-ins.
        this.tracks.forEach((bus, b) => {
            if (!bus.bus) return;
            for (const channel of bus.input[0]) channel.fill(0);
            for (const send of this.sends.filter((s) => s.to === b))
                for (let c = 0; c < 2; c++)
                    for (let k = 0; k < frames; k++) bus.input[0][c][k] += this.tracks[send.from].aligned[c][k] * send.gain;
            bus.chain.render(blockStart, frames, bus.input, bus.out);
            bus.aligned = bus.out[0];
        });
        // Everything into the master, at each track's level.
        for (const t of this.tracks)
            for (let c = 0; c < master.length; c++)
                for (let k = 0; k < frames; k++) master[c][k] += t.aligned[c][k] * t.gain;
    }
}

registerWclapProcessor("my-mixer", (host) => new Mixer(host));
