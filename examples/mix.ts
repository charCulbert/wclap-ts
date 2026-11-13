// Two tracks, each a chain, latency-compensated, both sending to a shared delay: a small mixer built from chains
// and ordinary Web Audio nodes. Notes on both tracks are scheduled on the same clock, so they line up to the sample.
import "compost/components/compost-knob";
import { alignLatency, createChain } from "../src/index.ts";
import { base, HIVE, showSource, started, status } from "./shared.ts";

void showSource("mix");
const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const context = await started();

const drums = await createChain(context, { base });
await drums.add("/test/fixtures/Tapa.wclap.tar.gz");
const synth = await createChain(context, { base });
await synth.add(HIVE);
await synth.add("/test/fixtures/PICOH-101.wclap.tar.gz");
const send = await createChain(context, { base });
await send.add("https://raw.githubusercontent.com/charCulbert/char-wclaps/main/Slide.wclap.tar.gz");

// Track outputs, delayed so both arrive together, then a fader each and a send each.
const aligned = await alignLatency([drums, synth]);
const master = new GainNode(context, { gain: 0.8 });
master.connect(context.destination);
send.connect(master);
const tracks = [
    {
        name: "drums",
        chain: drums,
        fader: new GainNode(context, { gain: 0.9 }),
        send: new GainNode(context, { gain: 0.2 }),
    },
    {
        name: "synth",
        chain: synth,
        fader: new GainNode(context, { gain: 0.7 }),
        send: new GainNode(context, { gain: 0.5 }),
    },
];
for (const t of tracks) {
    const out = aligned.get(t.chain);
    out?.connect(t.fader).connect(master);
    out?.connect(t.send).connect(send.input);
    for (const kind of ["fader", "send"] as const)
        $(`#${t.name}-${kind}`).addEventListener("parameter-edit", (e) => {
            t[kind].gain.setTargetAtTime((e as CustomEvent<{ value: number }>).detail.value, context.currentTime, 0.01);
        });
}

// A one-bar pattern, looped: kick and hat on the drums, a held chord for the sequencer.
let bar = context.currentTime + 0.1;
const beat = 0.5;
const play = () => {
    while (bar < context.currentTime + 1) {
        for (let i = 0; i < 4; i++) {
            const t = bar + i * beat;
            drums.noteOn(36, 0.9, t);
            drums.noteOff(36, 0, t + 0.1);
            drums.noteOn(42, 0.5, t + beat / 2);
            drums.noteOff(42, 0, t + beat / 2 + 0.05);
        }
        for (const key of [60, 64, 67]) {
            synth.noteOn(key, 0.7, bar);
            synth.noteOff(key, 0, bar + 4 * beat - 0.01);
        }
        bar += 4 * beat;
    }
};
play();
setInterval(play, 250);
status(`latency: drums ${await drums.latency()}, synth ${await synth.latency()} frames · compensated`);
