// One plug-in on a page: its own interface, a keyboard, MIDI, and its presets.
import "compost/components/compost-piano";
import { loadWclap } from "../src/index.ts";
import { base, showSource, started, status } from "./shared.ts";

void showSource("one");
const context = await started();
const synth = await loadWclap(context, "/test/fixtures/PICOH-101.wclap.tar.gz", {
    base,
    ui: document.querySelector<HTMLElement>("#ui") ?? undefined,
    onStats: (s) => status(`late notes ${s.late} · audio stalls ${s.stalls} · longest gap ${s.worstGapMs} ms`),
});
synth.connect(context.destination);
status(
    `${synth.descriptor.name} by ${synth.descriptor.vendor}, ${synth.threads === "two" ? "main-thread work on a Worker" : "all on the audio thread"}`,
);

const piano = document.querySelector("compost-piano");
piano?.addEventListener("note-down", (e) => synth.noteOn((e as CustomEvent<{ note: number }>).detail.note, 0.8));
piano?.addEventListener("note-up", (e) => synth.noteOff((e as CustomEvent<{ note: number }>).detail.note));

document.querySelector<HTMLButtonElement>("#midi")?.addEventListener("click", async () => {
    await synth.connectMidi();
    status("MIDI connected: every input plays the synth");
});

const presets = document.querySelector<HTMLSelectElement>("#presets");
const list = await synth.presets();
if (presets) {
    for (const [i, p] of list.entries()) presets.add(new Option(p.name, String(i)));
    presets.hidden = list.length === 0;
    presets.onchange = () => {
        const preset = list[Number(presets.value)];
        if (preset) void synth.loadPreset(preset);
    };
}
