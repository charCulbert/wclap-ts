// Web MIDI for a host: every input plays it (notes timed from when they arrived), controller knobs move mapped
// parameters, and the notes leaving the host go to a MIDI output.
import type { NoteOut } from "./typed-events.ts";
import type { WclapHost } from "./wclap-host.ts";
import type { WclapPlugin } from "./wclap-plugin.ts";

export class Midi {
    readonly #host: WclapHost;
    readonly #cc = new Map<string, { plugin: WclapPlugin; id: number }>();

    constructor(host: WclapHost) {
        this.#host = host;
    }

    // Every input plays the host, alongside anything else listening (another host, say). Returns a function that
    // stops.
    async connect(): Promise<() => void> {
        const access = await navigator.requestMIDIAccess();
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

    // A controller's CC moves a plug-in's parameter across its range (on every channel unless one is given).
    mapCC(cc: number, plugin: WclapPlugin, paramId: number, channel = -1): void {
        this.#cc.set(`${channel}:${cc}`, { plugin, id: paramId });
    }

    unmapCC(cc: number, channel = -1): void {
        this.#cc.delete(`${channel}:${cc}`);
    }

    // The notes leaving the host, to a MIDI output at the time they play. Returns a function that stops.
    connectOut(output: MIDIOutput): () => void {
        const host = this.#host;
        const listener = (e: CustomEvent<NoteOut>) => {
            const { on, key, velocity, channel, time } = e.detail;
            if (key < 0 || channel < 0) return;
            const at = performance.now() + (time - host.context.currentTime) * 1000;
            output.send([(on ? 0x90 : 0x80) | channel, key, Math.round(velocity * 127)], at);
        };
        host.addEventListener("noteout", listener);
        return () => host.removeEventListener("noteout", listener);
    }

    #receive(data: Uint8Array, sourceMs: number): void {
        const [status = 0, key = 0, velocity = 0] = data;
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        const host = this.#host;
        if (kind === 0xb0) {
            const mapped = this.#cc.get(`${channel}:${key}`) ?? this.#cc.get(`-1:${key}`);
            const p = mapped?.plugin.params.find((q) => q.id === mapped.id);
            if (mapped && p)
                host.schedule(
                    { type: "param", id: p.id, value: p.min + (velocity / 127) * (p.max - p.min) },
                    undefined,
                    mapped.plugin.id,
                    sourceMs,
                );
            return;
        }
        if (kind === 0x90 && velocity > 0)
            host.schedule({ type: "note-on", key, velocity: velocity / 127, channel }, undefined, -1, sourceMs);
        else if (kind === 0x80 || kind === 0x90)
            host.schedule({ type: "note-off", key, velocity: velocity / 127, channel }, undefined, -1, sourceMs);
    }
}
