// A chain builder: add plug-ins, reorder or bypass them while it plays, open each one's interface, play it from the
// keyboard or MIDI, or feed it a test tone.
import "compost/components/compost-piano";
import "compost/components/compost-knob";
import { createChain, type WclapPlugin } from "../src/index.ts";
import { base, HIVE, showSource, started, status } from "./shared.ts";

const catalogue: Record<string, string> = {
    "Hive (note sequencer)": HIVE,
    "PICOH-101 (synth)": "/test/fixtures/PICOH-101.wclap.tar.gz",
    "Tapa (percussion)": "/test/fixtures/Tapa.wclap.tar.gz",
    "Pro54 (synth)": "https://raw.githubusercontent.com/charCulbert/char-wclaps/main/Pro54.wclap.tar.gz",
    "Slide (delay)": "https://raw.githubusercontent.com/charCulbert/char-wclaps/main/Slide.wclap.tar.gz",
    "Headless Gain (no interface)": "/test/fixtures/HeadlessGain.wclap.tar.gz",
};

void showSource("chain");
const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const picker = $<HTMLSelectElement>("#pick");
for (const name of Object.keys(catalogue)) picker.add(new Option(name, name));

const context = await started();
const chain = await createChain(context, {
    base,
    onError: (message, plugin) => status(`${plugin?.descriptor.name ?? "chain"}: ${message.split("\n")[0]}`),
});
chain.connect(context.destination);

const list = $<HTMLOListElement>("#chain");
const ui = $<HTMLElement>("#ui");
let shown: WclapPlugin | undefined;

function render(): void {
    list.replaceChildren(
        ...chain.plugins.map((plugin, i) => {
            const item = document.createElement("li");
            const name = Object.assign(document.createElement("button"), { textContent: plugin.descriptor.name });
            const up = Object.assign(document.createElement("button"), { textContent: "↑", disabled: i === 0 });
            const bypass = Object.assign(document.createElement("button"), {
                textContent: plugin.enabled ? "Bypass" : "Enable",
            });
            const remove = Object.assign(document.createElement("button"), { textContent: "Remove" });
            name.onclick = async () => {
                shown?.hideInterface();
                shown = plugin;
                await plugin.showInterface(ui);
            };
            up.onclick = () => {
                chain.move(plugin, i - 1);
                render();
            };
            bypass.onclick = () => {
                plugin.enabled = !plugin.enabled;
                render();
            };
            remove.onclick = async () => {
                if (shown === plugin) shown = undefined;
                await chain.remove(plugin);
                render();
            };
            item.append(name, up, bypass, remove, ` ${plugin.threads === "two" ? "2 threads" : "1 thread"}`);
            return item;
        }),
    );
}

$<HTMLButtonElement>("#add").onclick = async () => {
    status(`loading ${picker.value}…`);
    const plugin = await chain.add(catalogue[picker.value] ?? "");
    status(`added ${plugin.descriptor.name} · chain latency ${await chain.latency()} frames`);
    render();
};

const piano = $<HTMLElement>("compost-piano");
piano.addEventListener("note-down", (e) => chain.noteOn((e as CustomEvent<{ note: number }>).detail.note, 0.8));
piano.addEventListener("note-up", (e) => chain.noteOff((e as CustomEvent<{ note: number }>).detail.note));
$<HTMLButtonElement>("#midi").onclick = async () => {
    await chain.connectMidi();
    status("MIDI connected");
};
$<HTMLElement>("#tempo").addEventListener("parameter-edit", (e) => {
    chain.transport.tempo = (e as CustomEvent<{ value: number }>).detail.value;
});

// A test tone for effects: a short pluck every half second.
let tone: OscillatorNode | undefined;
$<HTMLButtonElement>("#tone").onclick = () => {
    if (tone) {
        tone.stop();
        tone = undefined;
        return;
    }
    tone = new OscillatorNode(context, { type: "sawtooth", frequency: 220 });
    const gain = new GainNode(context, { gain: 0 });
    for (let t = context.currentTime; t < context.currentTime + 120; t += 0.5) {
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    }
    tone.connect(gain).connect(chain.input);
    tone.start();
};
