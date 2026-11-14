// One plug-in, from the page: its parameters, notes, state, presets, interface and events.

import type {
    Change,
    Indication,
    InterfaceInfo,
    NoteName,
    ParamInfo,
    Ports,
    Preset,
    RemoteControlsPage,
    StateContext,
    VoiceInfo,
} from "../plugin/plugin-types.ts";
import type { Descriptor } from "../plugin/wasm-instance.ts";
import type { Bundle } from "../plugin/wclap-bundle.ts";
import type { CallResult, FromMain, MainCall } from "../threads/main-thread-calls.ts";
import type { Info } from "../worklet/worklet-host.ts";
import type { Link } from "./message-link.ts";
import { hideInterface, showInterface } from "./plugin-interface.ts";
import { type PluginEvents, TypedTarget } from "./typed-events.ts";
import type { WclapHost } from "./wclap-host.ts";

// Events: "param" (CustomEvent<{ id, value }>) when the plug-in moves a parameter itself; "gesture"
// (CustomEvent<{ id, begin }>) when its interface starts or ends a drag, one undo step; "change"
// (CustomEvent<{ what }>) when its latency, parameter list (now in `params`), note names, ports, state,
// remote-control pages or voice info change; "suggest-page" (CustomEvent<{ pageId }>) when it suggests a
// remote-controls page to show.
export class WclapPlugin extends TypedTarget<PluginEvents> {
    readonly host: WclapHost;
    readonly id: number;
    readonly descriptor: Descriptor;
    params: ParamInfo[];
    readonly ports: Ports;
    readonly bundle: Bundle;
    // Where its main-thread work runs: "two" on the Worker, "one" on the audio thread between blocks.
    readonly threads: "one" | "two";
    // Why it runs on the audio thread alone, when it does.
    readonly oneThreadReason: string;
    // Each parameter's latest value as far as the page knows: what it set, or what the plug-in reported.
    readonly values = new Map<number, number>();
    #enabled = true;
    #failed = false;
    #ownsChain = false;
    readonly #main: Link;
    // Set by showInterface: where the plug-in's messages to its page go, and its window size requests.
    /** @internal */
    toInterface: ((bytes: Uint8Array) => void) | undefined;
    /** @internal */
    onInterfaceRequest: ((request: string, width?: number, height?: number) => void) | undefined;

    constructor(
        host: WclapHost,
        id: number,
        info: Info,
        bundle: Bundle,
        main: Link,
        threads: "one" | "two",
        oneThreadReason = "",
    ) {
        super();
        this.oneThreadReason = oneThreadReason;
        this.host = host;
        this.id = id;
        this.descriptor = info.descriptor;
        this.params = info.params;
        this.ports = info.ports;
        this.bundle = bundle;
        this.#main = main;
        this.threads = threads;
    }

    // It trapped on the audio thread: silent from then on.
    get failed(): boolean {
        return this.#failed;
    }
    /** @internal */
    markFailed(): void {
        this.#failed = true;
    }

    // Made by loadWclap: the chain is this plug-in's own.
    get ownsChain(): boolean {
        return this.#ownsChain;
    }
    /** @internal */
    own(): void {
        this.#ownsChain = true;
    }

    // Reports the plug-in makes on the audio thread reach the page a little later than its answers to calls, so
    // one made before the page's own change to a parameter, or before a state or preset load the page has read
    // back, would undo it. By the frame each report was made on, those are dropped: the frame each parameter was
    // last set from here, and the frame the last load was read back on.
    readonly #setAt = new Map<number, number>();
    #loadedAt = Number.NEGATIVE_INFINITY;

    /** @internal */
    changed(id: number, value: number, frame = Number.POSITIVE_INFINITY): void {
        if (frame < this.#loadedAt || frame < (this.#setAt.get(id) ?? Number.NEGATIVE_INFINITY)) return;
        this.values.set(id, value);
        this.dispatchEvent(new CustomEvent("param", { detail: { id, value } }));
    }

    /** @internal */
    gesture(id: number, begin: boolean): void {
        this.dispatchEvent(new CustomEvent("gesture", { detail: { id, begin } }));
    }

    #change(what: Change): void {
        this.dispatchEvent(new CustomEvent("change", { detail: { what } }));
        if (what === "latency") this.host.latencyChanged();
    }

    /** @internal */
    receive(m: FromMain): void {
        if (m.type === "log") this.host.options.onLog?.(m.text, m.severity, this);
        else if (m.type === "suggest-page")
            this.dispatchEvent(new CustomEvent("suggest-page", { detail: { pageId: m.pageId } }));
        else if (m.type === "interface-message") this.toInterface?.(m.bytes);
        else if (m.type === "interface-request") this.onInterfaceRequest?.(m.request, m.width, m.height);
        else if (m.type === "spawn") this.host.startThread(this.id, m.start);
        else if (m.what === "params")
            void this.call({ call: "params" }).then((params) => {
                this.params = params;
                this.#change("params");
            });
        else this.#change(m.what);
    }

    /** @internal */
    call<C extends MainCall>(call: C): Promise<CallResult<C["call"]>> {
        return this.#main.call(this.id, call) as Promise<CallResult<C["call"]>>;
    }

    get enabled(): boolean {
        return this.#enabled;
    }
    set enabled(on: boolean) {
        this.#enabled = on;
        this.host.setEnabled(this, on);
    }

    noteOn(key: number, velocity = 1, when?: number, channel = 0): boolean {
        return this.host.schedule({ type: "note-on", key, velocity, channel }, when, this.id);
    }

    noteOff(key: number, velocity = 0, when?: number, channel = 0): boolean {
        return this.host.schedule({ type: "note-off", key, velocity, channel }, when, this.id);
    }

    // Stops every note held on the key at once, with no release (a closed hi-hat cutting off an open one).
    choke(key: number, when?: number, channel = 0): boolean {
        return this.host.schedule({ type: "note-choke", key, velocity: 0, channel }, when, this.id);
    }

    // One raw MIDI message (sysex included) to this plug-in, at `when` like noteOn; see WclapHost.midi.
    midi(bytes: ArrayLike<number>, when?: number): boolean {
        return this.host.sendMidi(bytes, when, this.id);
    }

    param(id: number, value: number, when?: number): boolean {
        const rate = this.host.context.sampleRate;
        const frame = when === undefined ? this.host.clock.frameAt(performance.now()) : Math.round(when * rate);
        this.#setAt.set(id, frame);
        const live = when === undefined;
        const scheduled = this.host.schedule({ type: "param", id, value, live }, frame / rate, this.id);
        // Followers (panels, knobs) hear of it when it takes effect, not when it was scheduled.
        const delay = when === undefined ? 0 : Math.max(0, (when - this.host.context.currentTime) * 1000);
        const apply = () => {
            this.values.set(id, value);
            this.dispatchEvent(new CustomEvent("value", { detail: { id, value } }));
        };
        if (delay < 4) apply();
        else setTimeout(apply, delay);
        return scheduled;
    }

    // Offsets a parameter without moving it: for every voice, or one note's with `note`.
    modulate(id: number, amount: number, when?: number, note?: { key: number; channel?: number }): boolean {
        const event = note
            ? { type: "param-mod" as const, id, value: amount, key: note.key, channel: note.channel ?? 0 }
            : { type: "param-mod" as const, id, value: amount };
        return this.host.schedule(event, when, this.id);
    }

    // Shapes one sounding note: CLAP_NOTE_EXPRESSION_* (tuning in semitones, pressure 0..1, and so on).
    expression(expression: number, key: number, value: number, when?: number, channel = 0): boolean {
        return this.host.schedule({ type: "expression", expression, key, value, channel }, when, this.id);
    }

    // Tells the plug-in how the page shows a parameter, so its interface can show it too: a control it's mapped to,
    // or its automation's state. A plug-in without param_indication ignores it.
    indicate(id: number, indication: Indication): Promise<void> {
        return this.call({ call: "indicate", id, ...indication });
    }

    remoteControls(): Promise<RemoteControlsPage[]> {
        return this.call({ call: "remote-controls" });
    }
    // Null without the voice-info extension.
    voiceInfo(): Promise<VoiceInfo | null> {
        return this.call({ call: "voice-info" });
    }
    noteNames(): Promise<NoteName[]> {
        return this.call({ call: "note-names" });
    }

    saveState(context?: StateContext): Promise<Uint8Array> {
        return this.call({ call: "save-state", context });
    }
    async loadState(bytes: Uint8Array, context?: StateContext): Promise<void> {
        await this.call({ call: "load-state", bytes, context });
        await this.#readValues();
    }

    // After a state or preset load, every parameter as the plug-in now has it; a "value" event for each change.
    async #readValues(): Promise<void> {
        const values = await this.call({ call: "param-values" });
        this.#loadedAt = Math.round(this.host.context.currentTime * this.host.context.sampleRate);
        for (const [id, value] of values) {
            if (this.values.get(id) === value) continue;
            this.values.set(id, value);
            this.dispatchEvent(new CustomEvent("value", { detail: { id, value } }));
        }
    }
    presets(): Promise<Preset[]> {
        return this.call({ call: "presets" });
    }
    async loadPreset(preset: Preset): Promise<void> {
        await this.call({ call: "load-preset", preset });
        await this.#readValues();
    }
    latency(): Promise<number> {
        return this.call({ call: "latency" });
    }
    tail(): Promise<number> {
        return this.call({ call: "tail" });
    }
    valueText(id: number, value: number): Promise<string | null> {
        return this.call({ call: "value-text", id, value });
    }
    openInterface(): Promise<InterfaceInfo | null> {
        return this.call({ call: "open-interface" });
    }

    // Shows the plug-in's own interface in `element`, or a generated panel if it has none.
    showInterface(element: HTMLElement): Promise<void> {
        return showInterface(this, element);
    }
    hideInterface(): void {
        hideInterface(this);
    }

    // A plug-in from loadWclap is a chain of one, and connects as one. A plug-in in a chain you made connects
    // through the chain.
    connect(destination: AudioNode): AudioNode {
        return this.#own().connect(destination);
    }
    disconnect(): void {
        this.#own().disconnect();
    }
    get input(): AudioNode {
        return this.#own().input;
    }
    #own(): WclapHost {
        if (!this.ownsChain) throw new Error("this plug-in is in a chain: connect the chain instead");
        return this.host;
    }
    // Every Web MIDI input plays this plug-in (from loadWclap; a chain's plug-ins are played through the chain).
    connectMidi(options: { sysex?: boolean } = {}): Promise<() => void> {
        return this.#own().connectMidi(options);
    }

    // Removes the plug-in from its chain; a plug-in from loadWclap ends its chain with it.
    destroy(): Promise<void> {
        return this.ownsChain ? this.host.destroy() : this.host.remove(this);
    }
}
