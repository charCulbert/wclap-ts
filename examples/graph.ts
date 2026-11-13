// Your own graph in one AudioWorklet: graph-worklet.ts is the mixer (tracks, a bus, sends, latency compensation to
// the sample), this page loads it with createHost and drives it. Compare mix.ts, which builds the same thing from
// separate chains and Web Audio nodes.
import "compost/components/compost-knob";
import { createHost, type WclapPlugin } from "../src/index.ts";
import type { Levels, Routing } from "./mixer.ts";
import { base, HIVE, showSource, started, status } from "./shared.ts";

void showSource("graph");
const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const context = await started();

const host = await createHost(context, { base, module: "/dist/examples/graph-worklet.js", processor: "wclap-mixer" });
host.connect(context.destination);
const tapa = await host.add("/test/fixtures/Tapa.wclap.tar.gz");
const hive = await host.add(HIVE);
const synth = await host.add("/test/fixtures/PICOH-101.wclap.tar.gz");
const slide = await host.add("https://raw.githubusercontent.com/charCulbert/char-wclaps/main/Slide.wclap.tar.gz");

// A bypassed or failed plug-in adds no latency to its track.
const latency = async (p: WclapPlugin) => (p.enabled && !p.failed ? await p.latency() : 0);
const gains = [0.9, 0.7, 0.8];
const sendGains = [0.2, 0.5];
const route = async (): Promise<Routing> => ({
    tracks: [
        { plugins: [tapa.id], gain: gains[0] ?? 1 },
        { plugins: [hive.id, synth.id], gain: gains[1] ?? 1 },
        { plugins: [slide.id], gain: gains[2] ?? 1, bus: true },
    ],
    sends: [
        { from: 0, to: 2, gain: sendGains[0] ?? 0 },
        { from: 1, to: 2, gain: sendGains[1] ?? 0 },
    ],
    latency: [await latency(tapa), (await latency(hive)) + (await latency(synth)), await latency(slide)],
});
const routing = await route();
host.send(routing);
host.addEventListener("latencychange", async () => host.send(await route()));

const levels = (): Levels => ({ levels: true, gains, sends: sendGains });
for (const [id, list, i] of [
    ["drums-fader", gains, 0],
    ["synth-fader", gains, 1],
    ["bus-fader", gains, 2],
    ["drums-send", sendGains, 0],
    ["synth-send", sendGains, 1],
] as const)
    $(`#${id}`).addEventListener("parameter-edit", (e) => {
        list[i] = (e as CustomEvent<{ value: number }>).detail.value;
        host.send(levels());
    });

// A one-bar pattern, looped and scheduled ahead: kick and hat to the drums, a held chord to the sequencer.
let bar = context.currentTime + 0.1;
const beat = 0.5;
const play = () => {
    while (bar < context.currentTime + 1) {
        for (let i = 0; i < 4; i++) {
            const t = bar + i * beat;
            tapa.noteOn(36, 0.9, t);
            tapa.noteOff(36, 0, t + 0.1);
            tapa.noteOn(42, 0.5, t + beat / 2);
            tapa.noteOff(42, 0, t + beat / 2 + 0.05);
        }
        for (const key of [60, 64, 67]) {
            hive.noteOn(key, 0.7, bar);
            hive.noteOff(key, 0, bar + 4 * beat - 0.01);
        }
        bar += 4 * beat;
    }
};
play();
setInterval(play, 250);
status(`latency, frames: drums ${routing.latency[0]}, synth ${routing.latency[1]}, compensated inside the worklet`);
