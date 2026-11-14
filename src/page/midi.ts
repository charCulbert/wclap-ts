// Web MIDI for a host: every input plays it (every message, timed from when it arrived), controller knobs move
// mapped parameters, and the MIDI leaving the host goes to a MIDI output.
import type { MidiOut } from "./typed-events.ts";
import type { WclapHost } from "./wclap-host.ts";
import type { WclapPlugin } from "./wclap-plugin.ts";

export class Midi {
    readonly #host: WclapHost;
    readonly #cc = new Map<string, { plugin: WclapPlugin; id: number }>();

    constructor(host: WclapHost) {
        this.#host = host;
    }

    // Every input plays the host, alongside anything else listening (another host, say); sysex only if asked for.
    // Returns a function that stops.
    async connect({ sysex = false }: { sysex?: boolean } = {}): Promise<() => void> {
        const access = await navigator.requestMIDIAccess({ sysex });
        const listener = (m: Event) => {
            const message = m as MIDIMessageEvent;
            this.#receive(message.data ?? new Uint8Array(), message.timeStamp);
        };
        const listening = new Set<MIDIInput>();
        const listen = () => {
            for (const input of access.inputs.values())
                if (!listening.has(input)) {
                    input.addEventListener("midimessage", listener);
                    listening.add(input);
                }
        };
        listen();
        access.addEventListener("statechange", listen);
        return () => {
            access.removeEventListener("statechange", listen);
            for (const input of listening) input.removeEventListener("midimessage", listener);
        };
    }

    // A controller's CC moves a plug-in's parameter across its range (on every channel unless one is given), and
    // isn't passed on as MIDI: the knob is that parameter's.
    mapCC(cc: number, plugin: WclapPlugin, paramId: number, channel = -1): void {
        this.#cc.set(`${channel}:${cc}`, { plugin, id: paramId });
    }

    unmapCC(cc: number, channel = -1): void {
        this.#cc.delete(`${channel}:${cc}`);
    }

    // The MIDI leaving the host, to a MIDI output at the time it plays. Returns a function that stops.
    connectOut(output: MIDIOutput): () => void {
        const host = this.#host;
        const listener = (e: CustomEvent<MidiOut>) => {
            const { data, time } = e.detail;
            output.send(data, performance.now() + (time - host.context.currentTime) * 1000);
        };
        host.addEventListener("midiout", listener);
        return () => host.removeEventListener("midiout", listener);
    }

    #receive(data: Uint8Array, sourceMs: number): void {
        const [status = 0, cc = 0, value = 0] = data;
        const host = this.#host;
        if ((status & 0xf0) === 0xb0) {
            const mapped = this.#cc.get(`${status & 0x0f}:${cc}`) ?? this.#cc.get(`-1:${cc}`);
            const p = mapped?.plugin.params.find((q) => q.id === mapped.id);
            if (mapped && p) {
                host.schedule(
                    { type: "param", id: p.id, value: p.min + (value / 127) * (p.max - p.min) },
                    undefined,
                    mapped.plugin.id,
                    sourceMs,
                );
                return;
            }
        }
        host.sendMidi(data, undefined, -1, sourceMs);
    }
}
