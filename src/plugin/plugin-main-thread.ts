// A plug-in's main-thread role (CLAP's [main-thread] calls): create, parameters, state, presets, its interface,
// activation, and the main-thread work it asks for.
import {
    CLAP_AUDIO_PORT_IS_MAIN,
    CLAP_EXT_AUDIO_PORTS,
    CLAP_EXT_GUI,
    CLAP_EXT_LATENCY,
    CLAP_EXT_NOTE_NAME,
    CLAP_EXT_NOTE_PORTS,
    CLAP_EXT_PARAMS,
    CLAP_EXT_PRESET_LOAD,
    CLAP_EXT_PRESET_LOAD_COMPAT,
    CLAP_EXT_REMOTE_CONTROLS,
    CLAP_EXT_REMOTE_CONTROLS_COMPAT,
    CLAP_EXT_RENDER,
    CLAP_EXT_STATE,
    CLAP_EXT_STATE_CONTEXT,
    CLAP_EXT_TAIL,
    CLAP_EXT_TIMER_SUPPORT,
    CLAP_EXT_VOICE_INFO,
    CLAP_EXT_WEBVIEW,
    CLAP_INVALID_ID,
    CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
    CLAP_NOTE_DIALECT_MIDI_MPE,
    CLAP_NOTE_DIALECT_MIDI2,
    CLAP_PRESET_DISCOVERY_FACTORY_ID,
    CLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT,
    CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN,
    CLAP_RENDER_OFFLINE,
    CLAP_STATE_CONTEXT_FOR_DUPLICATE,
    CLAP_STATE_CONTEXT_FOR_PRESET,
    CLAP_STATE_CONTEXT_FOR_PROJECT,
    CLAP_VOICE_INFO_SUPPORTS_OVERLAPPING_NOTES,
    clap_audio_buffer,
    clap_audio_port_info,
    clap_event_transport,
    clap_istream,
    clap_note_name,
    clap_note_port_info,
    clap_ostream,
    clap_param_info,
    clap_plugin,
    clap_plugin_audio_ports,
    clap_plugin_gui,
    clap_plugin_latency,
    clap_plugin_note_name,
    clap_plugin_note_ports,
    clap_plugin_params,
    clap_plugin_preset_load,
    clap_plugin_remote_controls,
    clap_plugin_render,
    clap_plugin_state,
    clap_plugin_state_context,
    clap_plugin_tail,
    clap_plugin_timer_support,
    clap_plugin_voice_info,
    clap_plugin_webview,
    clap_preset_discovery_factory,
    clap_preset_discovery_indexer,
    clap_preset_discovery_location,
    clap_preset_discovery_metadata_receiver,
    clap_preset_discovery_provider,
    clap_preset_discovery_provider_descriptor,
    clap_process,
    clap_remote_controls_page,
    clap_voice_info,
    clap_window,
} from "./clap.generated.ts";
import {
    type Behaviour,
    EVENT_SIZE,
    type EventList,
    installHost,
    MAX_EVENTS,
    MIDI_AREA,
    OutputList,
    type Request,
    writeHost,
} from "./clap-host-callbacks.ts";
import type {
    AudioSetup,
    InterfaceInfo,
    MainOptions,
    NoteName,
    ParamInfo,
    PortInfo,
    Ports,
    Preset,
    RemoteControlsPage,
    StateContext,
    VoiceInfo,
} from "./plugin-types.ts";
import { encodeUtf8 } from "./utf8.ts";
import type { Instance } from "./wasm-instance.ts";
import { asPtr, type Layout, NULL, type Struct } from "./wasm-struct.ts";

const STATE_CONTEXTS = {
    preset: CLAP_STATE_CONTEXT_FOR_PRESET,
    duplicate: CLAP_STATE_CONTEXT_FOR_DUPLICATE,
    project: CLAP_STATE_CONTEXT_FOR_PROJECT,
};

export class PluginMain {
    readonly instance: Instance;
    readonly plugin: Struct<typeof clap_plugin>;
    readonly requests = new Set<Request>();
    // In one thread, the audio half sets these while it processes.
    readonly events: EventList = { at: 0, count: 0 };
    readonly output = new OutputList();
    readonly thread = { audio: false };
    ports: Ports = { inputs: [], outputs: [] };
    #slots: number[];
    #host;
    #active = false;
    #activation = { sampleRate: 0, maxFrames: 0 };
    #extensions = new Map<string, number>();
    readonly #options: MainOptions;
    // The plug-in's timers by ID: its period and when it's next due, in Date.now() milliseconds.
    readonly #timers = new Map<number, { period: number; due: number }>();
    #nextTimer = 0;
    // The page the plug-in last suggested, until idle passes it on.
    #suggestedPage: number | undefined;
    #voiceInfo: VoiceInfo | null = null;

    static create(instance: Instance, id: string, options: MainOptions = {}): PluginMain {
        return new PluginMain(instance, id, options);
    }

    private constructor(instance: Instance, id: string, options: MainOptions) {
        this.instance = instance;
        this.#options = options;
        const log = options.log ?? ((message) => console.log(message));
        const extensions = new Map<string, number>();
        const behaviour: Behaviour = {
            events: this.events,
            output: this.output,
            extensions,
            request: (request) => {
                this.requests.add(request);
                options.onRequest?.(request);
            },
            log,
            isAudioThread: () => this.thread.audio,
            isMainThread: () => !this.thread.audio,
            webviewSend: (bytes) => {
                options.onInterfaceMessage?.(bytes);
                return !!options.onInterfaceMessage;
            },
            gui: (request, width, height) => options.onInterfaceRequest?.(request, width, height) ?? false,
            registerTimer: (periodMs) => {
                const id = this.#nextTimer++;
                const period = Math.max(1, periodMs);
                this.#timers.set(id, { period, due: Date.now() + period });
                return id;
            },
            unregisterTimer: (id) => this.#timers.delete(id),
            suggestPage: (pageId) => {
                this.#suggestedPage = pageId;
            },
        };
        this.#slots = installHost(instance.wasm, behaviour);
        this.#host = writeHost(instance, this.#slots);
        for (const [name, at] of this.#host.extensions) extensions.set(name, at);

        const factory = instance.factory;
        if (!factory) throw new Error("this instance has no plug-in factory");
        const at = factory.call("create_plugin", factory.at, this.#host.host, instance.allocString(id));
        if (!at) throw new Error(`the factory has no plug-in ${id}`);
        this.plugin = instance.wasm.struct(clap_plugin, at);
        if (!this.plugin.call("init", this.plugin.at)) throw new Error(`${id}: init failed`);
    }

    extension<L extends Layout>(id: string, layout: L): Struct<L> | null {
        let at = this.#extensions.get(id);
        if (at === undefined) {
            at = this.plugin.call("get_extension", this.plugin.at, this.instance.allocString(id)) as number;
            this.#extensions.set(id, at);
        }
        return at ? this.instance.wasm.struct(layout, asPtr(at)) : null;
    }

    params(): ParamInfo[] {
        const params = this.extension(CLAP_EXT_PARAMS, clap_plugin_params);
        if (!params) return [];
        const info = this.instance.allocStruct(clap_param_info);
        const list: ParamInfo[] = [];
        for (let i = 0; i < params.call("count", this.plugin.at); i++) {
            if (!params.call("get_info", this.plugin.at, i, info.at)) continue;
            list.push({
                id: info.get("id"),
                name: info.string("name"),
                module: info.string("module"),
                min: info.get("min_value"),
                max: info.get("max_value"),
                default: info.get("default_value"),
                flags: info.get("flags"),
            });
        }
        return list;
    }

    // Every parameter's current value, [id, value]: after a state or preset load, the page reads them back.
    paramValues(): [number, number][] {
        const params = this.extension(CLAP_EXT_PARAMS, clap_plugin_params);
        if (!params) return [];
        const info = this.instance.allocStruct(clap_param_info);
        const out = this.#scratch(8);
        const values: [number, number][] = [];
        for (let i = 0; i < params.call("count", this.plugin.at); i++) {
            if (!params.call("get_info", this.plugin.at, i, info.at)) continue;
            const id = info.get("id");
            if (params.call("get_value", this.plugin.at, id, asPtr(out)))
                values.push([id, this.instance.wasm.read("f64", out) as number]);
        }
        return values;
    }

    // A parameter value as the plug-in writes it ("440 Hz"), or null if it doesn't.
    valueText(id: number, value: number): string | null {
        const params = this.extension(CLAP_EXT_PARAMS, clap_plugin_params);
        const buffer = this.#scratch(256);
        if (!params?.call("value_to_text", this.plugin.at, id, value, asPtr(buffer), 256)) return null;
        return this.instance.wasm.string(asPtr(buffer), 256);
    }

    remoteControls(): RemoteControlsPage[] {
        const ext =
            this.extension(CLAP_EXT_REMOTE_CONTROLS, clap_plugin_remote_controls) ??
            this.extension(CLAP_EXT_REMOTE_CONTROLS_COMPAT, clap_plugin_remote_controls);
        if (!ext) return [];
        const page = this.instance.allocStruct(clap_remote_controls_page);
        const pages: RemoteControlsPage[] = [];
        for (let i = 0; i < ext.call("count", this.plugin.at); i++) {
            if (!ext.call("get", this.plugin.at, i, page.at)) continue;
            pages.push({
                section: page.string("section_name"),
                id: page.get("page_id"),
                name: page.string("page_name"),
                params: Array.from({ length: 8 }, (_, k) => page.item("param_ids", k)),
                forPreset: page.get("is_for_preset"),
            });
        }
        return pages;
    }

    noteNames(): NoteName[] {
        const ext = this.extension(CLAP_EXT_NOTE_NAME, clap_plugin_note_name);
        if (!ext) return [];
        const name = this.instance.allocStruct(clap_note_name);
        const names: NoteName[] = [];
        for (let i = 0; i < ext.call("count", this.plugin.at); i++) {
            if (!ext.call("get", this.plugin.at, i, name.at)) continue;
            names.push({
                name: name.string("name"),
                port: name.get("port"),
                key: name.get("key"),
                channel: name.get("channel"),
            });
        }
        return names;
    }

    // The voice info as last read: once active, and again each time the plug-in says it changed. Null without the
    // extension, or before the first activation.
    voiceInfo(): VoiceInfo | null {
        return this.#voiceInfo;
    }

    // voice_info.get is [main-thread & active].
    #readVoiceInfo(): void {
        const ext = this.extension(CLAP_EXT_VOICE_INFO, clap_plugin_voice_info);
        if (!ext) return;
        const info = this.instance.allocStruct(clap_voice_info);
        this.#voiceInfo = ext.call("get", this.plugin.at, info.at)
            ? {
                  count: info.get("voice_count"),
                  capacity: info.get("voice_capacity"),
                  overlapping: (info.get("flags") & BigInt(CLAP_VOICE_INFO_SUPPORTS_OVERLAPPING_NOTES)) !== 0n,
              }
            : null;
    }

    latency(): number {
        return this.extension(CLAP_EXT_LATENCY, clap_plugin_latency)?.call("get", this.plugin.at) ?? 0;
    }

    // In frames; 0xffffffff means it rings on indefinitely.
    tail(): number {
        return this.extension(CLAP_EXT_TAIL, clap_plugin_tail)?.call("get", this.plugin.at) ?? 0;
    }

    // Opens the plug-in's interface in CLAP's order (create, set_parent, show) and says where its page is, or null
    // if it has no web interface.
    openInterface(): InterfaceInfo | null {
        const webview = this.extension(CLAP_EXT_WEBVIEW, clap_plugin_webview);
        if (!webview) return null;
        const gui = this.extension(CLAP_EXT_GUI, clap_plugin_gui);
        const at = this.plugin.at;
        let width = 0;
        let height = 0;
        let resizable = false;
        if (gui) {
            const api = this.instance.allocString("webview");
            if (!gui.call("is_api_supported", at, api, false) || !gui.call("create", at, api, false)) return null;
            const size = this.#scratch(8);
            if (gui.call("get_size", at, asPtr(size), asPtr(size + 4))) {
                width = this.instance.wasm.read("u32", size) as number;
                height = this.instance.wasm.read("u32", size + 4) as number;
            }
            resizable = Boolean(gui.call("can_resize", at));
            const window = this.instance.allocStruct(clap_window);
            window.set("api", api);
            gui.call("set_parent", at, window.at);
            gui.call("show", at);
        }
        const buffer = this.#scratch(2048);
        const length = webview.call("get_uri", at, asPtr(buffer), 2048);
        if (length <= 0) return null;
        return { uri: this.instance.wasm.string(asPtr(buffer), 2048), width, height, resizable };
    }

    // Asks a resizable interface for the size nearest `width` x `height` it accepts (gui.adjust_size), then gives it
    // that size (gui.set_size). Returns the size it took, or null if it can't be resized.
    resizeInterface(width: number, height: number): { width: number; height: number } | null {
        const gui = this.extension(CLAP_EXT_GUI, clap_plugin_gui);
        const at = this.plugin.at;
        if (!gui?.call("can_resize", at)) return null;
        const size = this.#scratch(8);
        this.instance.wasm.write("u32", size, Math.max(1, Math.round(width)));
        this.instance.wasm.write("u32", size + 4, Math.max(1, Math.round(height)));
        gui.call("adjust_size", at, asPtr(size), asPtr(size + 4));
        const w = this.instance.wasm.read("u32", size) as number;
        const h = this.instance.wasm.read("u32", size + 4) as number;
        return gui.call("set_size", at, w, h) ? { width: w, height: h } : null;
    }

    closeInterface(): void {
        const gui = this.extension(CLAP_EXT_GUI, clap_plugin_gui);
        gui?.call("hide", this.plugin.at);
        gui?.call("destroy", this.plugin.at);
    }

    // One file of its interface, by the absolute path its page asked for ("/page/main.js"): the plug-in serves it
    // (webview's get_resource), from wherever it keeps it. Null if it has no such file, or serves none.
    getResource(path: string): { mime: string; bytes: Uint8Array } | null {
        const webview = this.extension(CLAP_EXT_WEBVIEW, clap_plugin_webview);
        if (!webview?.get("get_resource")) return null;
        // Not TextEncoder: an AudioWorklet, where a one-thread plug-in's main role runs, has none.
        const encoded = encodeUtf8(path);
        const at = this.#scratch(encoded.length + 1 + 256);
        const wasm = this.instance.wasm;
        wasm.bytes.set(encoded, at);
        wasm.bytes[at + encoded.length] = 0;
        const mime = at + encoded.length + 1;
        wasm.bytes[mime] = 0;
        const { out } = this.#stream();
        this.#streamData.chunks = [];
        if (!webview.call("get_resource", this.plugin.at, asPtr(at), asPtr(mime), 256, out.at)) return null;
        const chunks = this.#streamData.chunks;
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.length;
        }
        return { mime: wasm.string(asPtr(mime), 256), bytes };
    }

    // A message from the interface's page to the plug-in.
    sendToInterface(bytes: Uint8Array): boolean {
        const webview = this.extension(CLAP_EXT_WEBVIEW, clap_plugin_webview);
        if (!webview) return false;
        const at = this.#scratch(bytes.length);
        this.instance.wasm.bytes.set(bytes, at);
        return webview.call("receive", this.plugin.at, asPtr(at), bytes.length);
    }

    // The plug-in's own presets (those it lists itself; preset files come with bundle files).
    presets(): Preset[] {
        const instance = this.instance;
        const wasm = instance.wasm;
        const at =
            instance.getFactory(CLAP_PRESET_DISCOVERY_FACTORY_ID) ||
            instance.getFactory(CLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT);
        if (!at) return [];
        const factory = wasm.struct(clap_preset_discovery_factory, asPtr(at));
        const found: Preset[] = [];
        const locations: { kind: number; location: string }[] = [];
        const indexer = instance.allocStruct(clap_preset_discovery_indexer);
        indexer.set("name", instance.allocString("wclap-ts"));
        indexer.setFn("declare_filetype", () => true);
        indexer.setFn("declare_soundpack", () => true);
        indexer.setFn("get_extension", () => NULL);
        indexer.setFn("declare_location", (_indexer, location) => {
            const l = wasm.struct(clap_preset_discovery_location, location);
            locations.push({ kind: l.get("kind"), location: l.get("location") ? l.string("location") : "" });
            return true;
        });
        const receiver = instance.allocStruct(clap_preset_discovery_metadata_receiver);
        let current: { kind: number; location: string } = { kind: 0, location: "" };
        receiver.setFn("begin_preset", (_receiver, name, loadKey) => {
            found.push({
                name: name ? wasm.string(name) : "",
                kind: current.kind,
                location: current.location,
                loadKey: loadKey ? wasm.string(loadKey) : "",
            });
            return true;
        });
        for (const field of [
            "on_error",
            "add_plugin_id",
            "set_soundpack_id",
            "set_flags",
            "add_creator",
            "set_description",
            "set_timestamps",
            "add_feature",
            "add_extra_info",
        ] as const)
            receiver.setFn(field, () => undefined);
        for (let i = 0; i < factory.call("count", factory.at); i++) {
            const desc = wasm.struct(
                clap_preset_discovery_provider_descriptor,
                factory.call("get_descriptor", factory.at, i),
            );
            const provider = factory.call("create", factory.at, indexer.at, instance.allocString(desc.string("id")));
            if (!provider) continue;
            const p = wasm.struct(clap_preset_discovery_provider, provider);
            locations.length = 0;
            if (p.call("init", p.at)) {
                for (const l of [...locations]) {
                    if (l.kind !== CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN) continue;
                    current = l;
                    p.call("get_metadata", p.at, l.kind, NULL, receiver.at);
                }
            }
            p.call("destroy", p.at);
        }
        return found;
    }

    loadPreset(preset: Preset): void {
        const load =
            this.extension(CLAP_EXT_PRESET_LOAD, clap_plugin_preset_load) ??
            this.extension(CLAP_EXT_PRESET_LOAD_COMPAT, clap_plugin_preset_load);
        if (!load) throw new Error("the plug-in can't load presets");
        const location = preset.location ? this.instance.allocString(preset.location) : NULL;
        const key = preset.loadKey ? this.instance.allocString(preset.loadKey) : NULL;
        if (!load.call("from_location", this.plugin.at, preset.kind, location, key))
            throw new Error(`the plug-in couldn't load ${preset.name}`);
    }

    #scratchAt = 0;
    #scratchSize = 0;

    // A buffer in the plug-in's memory for short-lived host data, reused and grown as needed.
    #scratch(size: number): number {
        if (size > this.#scratchSize) {
            this.#scratchSize = Math.max(size, this.#scratchSize * 2, 4096);
            this.#scratchAt = this.instance.alloc(this.#scratchSize);
        }
        return this.#scratchAt;
    }

    // Allocates everything process needs, then activates.
    activate(sampleRate: number, maxFrames: number): AudioSetup {
        if (this.#active) throw new Error("already active");
        const inputInfo = this.#portInfo(true);
        const outputInfo = this.#portInfo(false);
        this.ports = {
            inputs: inputInfo.map((p) => p.channels),
            outputs: outputInfo.map((p) => p.channels),
            inputInfo,
            outputInfo,
        };
        const inputs = this.#buffers(this.ports.inputs, maxFrames);
        const outputs = this.#buffers(this.ports.outputs, maxFrames);
        const process = this.instance.allocStruct(clap_process);
        process.set("audio_inputs", asPtr(inputs.buffers));
        process.set("audio_outputs", asPtr(outputs.buffers));
        process.set("audio_inputs_count", this.ports.inputs.length);
        process.set("audio_outputs_count", this.ports.outputs.length);
        process.set("in_events", this.#host.inEvents);
        process.set("out_events", this.#host.outEvents);
        const transport = this.instance.allocStruct(clap_event_transport);
        process.set("transport", transport.at);
        const setup: AudioSetup = {
            params: this.extension(CLAP_EXT_PARAMS, clap_plugin_params)?.at ?? 0,
            tail: this.extension(CLAP_EXT_TAIL, clap_plugin_tail)?.at ?? 0,
            plugin: this.plugin.at,
            process: process.at,
            transport: transport.at,
            events: this.instance.alloc(MAX_EVENTS * EVENT_SIZE),
            midi: this.instance.alloc(MIDI_AREA),
            ...this.#noteDialect(),
            inputs: inputs.channels,
            outputs: outputs.channels,
            maxFrames,
            slots: this.#slots,
            extensions: [...this.#host.extensions],
        };
        this.#activation = { sampleRate, maxFrames };
        // Realtime is every plug-in's default, so only offline is said.
        if (this.#options.offline) {
            const render = this.extension(CLAP_EXT_RENDER, clap_plugin_render);
            if (render && !render.call("set", this.plugin.at, CLAP_RENDER_OFFLINE))
                this.#options.log?.("the plug-in can't render offline: it renders as in realtime", "warning");
        }
        if (!this.plugin.call("activate", this.plugin.at, sampleRate, 1, maxFrames)) throw new Error("activate failed");
        this.#active = true;
        this.#readVoiceInfo();
        return setup;
    }

    // How its first note input takes notes: in the dialect it prefers (MIDI for MIDI with MPE), or without one, CLAP
    // if it takes it, then MIDI, then MIDI 2. A plug-in without note inputs gets CLAP notes.
    #noteDialect(): { dialect: number; dialects: number } {
        const ports = this.extension(CLAP_EXT_NOTE_PORTS, clap_plugin_note_ports);
        const info = this.instance.allocStruct(clap_note_port_info);
        if (
            !ports ||
            ports.call("count", this.plugin.at, true) < 1 ||
            !ports.call("get", this.plugin.at, 0, true, info.at)
        )
            return { dialect: CLAP_NOTE_DIALECT_CLAP, dialects: CLAP_NOTE_DIALECT_CLAP };
        const dialects = info.get("supported_dialects") as number;
        const preferred = info.get("preferred_dialect") as number;
        const midi = CLAP_NOTE_DIALECT_MIDI | CLAP_NOTE_DIALECT_MIDI_MPE;
        const dialect =
            preferred === CLAP_NOTE_DIALECT_CLAP || preferred === CLAP_NOTE_DIALECT_MIDI2
                ? preferred
                : preferred & midi
                  ? CLAP_NOTE_DIALECT_MIDI
                  : dialects & CLAP_NOTE_DIALECT_CLAP || !dialects
                    ? CLAP_NOTE_DIALECT_CLAP
                    : dialects & midi
                      ? CLAP_NOTE_DIALECT_MIDI
                      : CLAP_NOTE_DIALECT_MIDI2;
        return { dialect, dialects };
    }

    #portChannels(input: boolean): number[] {
        return this.#portInfo(input).map((p) => p.channels);
    }

    #portInfo(input: boolean): PortInfo[] {
        const ports = this.extension(CLAP_EXT_AUDIO_PORTS, clap_plugin_audio_ports);
        if (!ports) return [];
        const info = this.instance.allocStruct(clap_audio_port_info);
        const list: PortInfo[] = [];
        for (let i = 0; i < ports.call("count", this.plugin.at, input); i++) {
            if (!ports.call("get", this.plugin.at, i, input, info.at)) throw new Error(`audio port ${i} has no info`);
            list.push({
                id: info.get("id"),
                name: info.string("name"),
                channels: info.get("channel_count"),
                main: (info.get("flags") & CLAP_AUDIO_PORT_IS_MAIN) !== 0,
                type: info.string("port_type"),
                inPlacePair: info.get("in_place_pair") === CLAP_INVALID_ID ? -1 : info.get("in_place_pair"),
            });
        }
        return list;
    }

    #buffers(counts: number[], maxFrames: number): { buffers: number; channels: number[][] } {
        const instance = this.instance;
        const buffers = instance.alloc(counts.length * clap_audio_buffer.size);
        const channels = counts.map((count, i) => {
            const buffer = instance.wasm.struct(clap_audio_buffer, asPtr(buffers + i * clap_audio_buffer.size));
            const list = instance.alloc(count * 4);
            const data = Array.from({ length: count }, (_, c) => {
                const at = instance.alloc(maxFrames * 4);
                instance.wasm.write("u32", list + c * 4, at);
                return at;
            });
            buffer.set("data32", asPtr(list));
            buffer.set("channel_count", count);
            return data;
        });
        return { buffers, channels };
    }

    // The host's extensions as written in the plug-in's memory, for other instances' get_extension.
    hostExtensions(): [string, number][] {
        return [...this.#host.extensions];
    }

    // For the audio side on this thread: a request_process or params.request_flush from this instance or, through
    // the control block, from the plug-in's other threads.
    takeAudioRequest(request: "process" | "params-flush"): boolean {
        const here = this.requests.delete(request);
        return (this.#options.control?.takeAudio(request) ?? false) || here;
    }

    // Main-thread work the plug-in asked for.
    idle(): void {
        if (this.#options.control) for (const r of this.#options.control.take()) this.requests.add(r);
        if (this.requests.delete("callback")) this.plugin.call("on_main_thread", this.plugin.at);
        if (this.requests.delete("latency")) this.#options.onChange?.("latency");
        if (this.requests.delete("params-rescan")) this.#options.onChange?.("params");
        if (this.requests.delete("note-names")) this.#options.onChange?.("note-names");
        if (this.requests.delete("state-dirty")) this.#options.onChange?.("state");
        if (this.requests.delete("remote-controls")) this.#options.onChange?.("remote-controls");
        if (this.#suggestedPage !== undefined) {
            const page = this.#suggestedPage;
            this.#suggestedPage = undefined;
            this.#options.onSuggestPage?.(page);
        }
        // Inactive, it's read on the next activation.
        if (this.requests.delete("voice-info")) {
            if (this.#active) this.#readVoiceInfo();
            this.#options.onChange?.("voice-info");
        }
        this.#runTimers();
    }

    // Milliseconds until the plug-in's next timer is due (0 if one is), or Infinity if it has none: idle must run
    // by then for the timer to keep its period.
    timerDue(): number {
        let due = Number.POSITIVE_INFINITY;
        for (const t of this.#timers.values()) due = Math.min(due, t.due);
        return Math.max(0, due - Date.now());
    }

    // Each timer that's due, once; one that fell more than a period behind (a suspended context) skips ahead
    // rather than firing in a burst.
    #runTimers(): void {
        if (!this.#timers.size) return;
        const ext = this.extension(CLAP_EXT_TIMER_SUPPORT, clap_plugin_timer_support);
        const now = Date.now();
        for (const [id, t] of this.#timers) {
            if (t.due > now) continue;
            t.due += t.period;
            if (t.due <= now) t.due = now + t.period;
            ext?.call("on_timer", this.plugin.at, id);
        }
    }

    #streams: { out: Struct<typeof clap_ostream>; in: Struct<typeof clap_istream> } | undefined;
    #streamData = { chunks: [] as Uint8Array[], input: new Uint8Array(0) as Uint8Array, read: 0 };

    #stream() {
        if (this.#streams) return this.#streams;
        const wasm = this.instance.wasm;
        const data = this.#streamData;
        const out = this.instance.allocStruct(clap_ostream);
        out.setFn("write", (_stream, buffer, size) => {
            data.chunks.push(wasm.bytes.slice(buffer, buffer + Number(size)));
            return size;
        });
        const input = this.instance.allocStruct(clap_istream);
        input.setFn("read", (_stream, buffer, size) => {
            const chunk = data.input.subarray(data.read, data.read + Number(size));
            wasm.bytes.set(chunk, buffer);
            data.read += chunk.length;
            return BigInt(chunk.length);
        });
        this.#streams = { out, in: input };
        return this.#streams;
    }

    // With a context, a plug-in with state-context hears what the state is for; others get plain state.
    saveState(context?: StateContext): Uint8Array {
        const state = this.extension(CLAP_EXT_STATE, clap_plugin_state);
        if (!state) throw new Error("the plug-in has no state");
        const { out } = this.#stream();
        this.#streamData.chunks = [];
        const withContext = context && this.extension(CLAP_EXT_STATE_CONTEXT, clap_plugin_state_context);
        const saved = withContext
            ? withContext.call("save", this.plugin.at, out.at, STATE_CONTEXTS[context])
            : state.call("save", this.plugin.at, out.at);
        if (!saved) throw new Error("the plug-in failed to save its state");
        const chunks = this.#streamData.chunks;
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
        }
        return bytes;
    }

    loadState(bytes: Uint8Array, context?: StateContext): void {
        const state = this.extension(CLAP_EXT_STATE, clap_plugin_state);
        if (!state) throw new Error("the plug-in has no state");
        const { in: input } = this.#stream();
        this.#streamData.input = bytes;
        this.#streamData.read = 0;
        const withContext = context && this.extension(CLAP_EXT_STATE_CONTEXT, clap_plugin_state_context);
        const loaded = withContext
            ? withContext.call("load", this.plugin.at, input.at, STATE_CONTEXTS[context])
            : state.call("load", this.plugin.at, input.at);
        if (!loaded) throw new Error("the plug-in failed to load the state");
    }

    // A plug-in's restart request: after the audio side has stopped processing, deactivate and activate again with
    // the same buffers. The audio side starts processing again on its next block.
    restart(): void {
        if (!this.#active) return;
        this.plugin.call("deactivate", this.plugin.at);
        const { sampleRate, maxFrames } = this.#activation;
        // The buffers stay as they were, so a plug-in that changed its ports gets the old layout: the page hears of
        // it and can load the plug-in again.
        const ports = { inputs: this.#portChannels(true), outputs: this.#portChannels(false) };
        if (ports.inputs.join() !== this.ports.inputs.join() || ports.outputs.join() !== this.ports.outputs.join())
            this.#options.onChange?.("ports");
        this.#active = this.plugin.call("activate", this.plugin.at, sampleRate, 1, maxFrames);
        if (!this.#active) throw new Error("activate failed after a restart");
        this.#readVoiceInfo();
        this.requests.add("latency");
    }

    // After the audio side has stopped processing.
    destroy(): void {
        if (this.#active) this.plugin.call("deactivate", this.plugin.at);
        this.#active = false;
        this.#timers.clear();
        this.plugin.call("destroy", this.plugin.at);
    }
}
