// A/B: two plug-ins (or two builds of one) fed the same input, switched without a click. Each note reaches both on
// the same frame, so the comparison is fair.
import "compost/components/compost-meter";
import "compost/components/compost-piano";
import { loadWclap } from "../src/index.ts";
import { base, showSource, started, status } from "./shared.ts";

void showSource("ab");
const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const context = await started();
const a = await loadWclap(context, "/test/fixtures/PICOH-101.wclap.tar.gz", { base, ui: $("#ui-a") });
const b = await loadWclap(
    context,
    "https://raw.githubusercontent.com/charCulbert/char-wclaps/main/Pro54.wclap.tar.gz",
    {
        base,
        ui: $("#ui-b"),
    },
);

const gainA = new GainNode(context, { gain: 1 });
const gainB = new GainNode(context, { gain: 0 });
a.connect(gainA).connect(context.destination);
b.connect(gainB).connect(context.destination);

// Switch with a 20 ms crossfade, and dim the side you're not hearing.
let hearing: "a" | "b" = "a";
const switchTo = (side: "a" | "b") => {
    hearing = side;
    const now = context.currentTime;
    gainA.gain.setTargetAtTime(side === "a" ? 1 : 0, now, 0.005);
    gainB.gain.setTargetAtTime(side === "b" ? 1 : 0, now, 0.005);
    $("#a").classList.toggle("primary", side === "a");
    $("#b").classList.toggle("primary", side === "b");
};
$<HTMLButtonElement>("#a").onclick = () => switchTo("a");
$<HTMLButtonElement>("#b").onclick = () => switchTo("b");
addEventListener("keydown", (e) => e.key === " " && switchTo(hearing === "a" ? "b" : "a"));
switchTo("a");

// The same note to both, at the same moment.
const piano = $<HTMLElement>("compost-piano");
piano.addEventListener("note-down", (e) => {
    const key = (e as CustomEvent<{ note: number }>).detail.note;
    const when = context.currentTime + 0.01;
    a.noteOn(key, 0.8, when);
    b.noteOn(key, 0.8, when);
});
piano.addEventListener("note-up", (e) => {
    const key = (e as CustomEvent<{ note: number }>).detail.note;
    const when = context.currentTime + 0.01;
    a.noteOff(key, 0, when);
    b.noteOff(key, 0, when);
});

// Levels, before the switch, so you see both.
const meters = [a, b].map((plugin, i) => {
    const analyser = new AnalyserNode(context, { fftSize: 1024 });
    plugin.connect(analyser);
    return {
        analyser,
        meter: $<HTMLElement & { value: number }>(`#meter-${i ? "b" : "a"}`),
        data: new Float32Array(1024),
    };
});
const draw = () => {
    for (const m of meters) {
        m.analyser.getFloatTimeDomainData(m.data);
        m.meter.value = m.data.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);
    }
    requestAnimationFrame(draw);
};
draw();
status(`A: ${a.descriptor.name} · B: ${b.descriptor.name} · space bar switches`);
