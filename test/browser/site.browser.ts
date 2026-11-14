// The site's nine examples in Google Chrome: each page starts, plays, and logs no errors. Run by
// `npm run test:browser` (not `npm test`: it needs Chrome and the network, since most pages load their plug-ins from
// GitHub). Audio is checked only for not being silent; test/refs.test.ts compares exact output with saved
// references in Node, so it isn't repeated here. The last tests drive the library on a bare page
// (test/browser/harness.html) with the repo's own test plug-ins.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { type Fixture, fetchFixture, OPEN_WEBCLAP_BUNDLES, TEST_PLUGINS } from "../fetch-fixture.ts";

const root = new URL("../../site/", import.meta.url).pathname;
// Beside the site: /test/ is this folder (harness.html), /fixtures/ the repo's test plug-ins, /cache/<name> a fetched
// bundle (test/fetch-fixture.ts).
const folders: Record<string, string> = {
    "/test/": new URL(".", import.meta.url).pathname,
    "/fixtures/": new URL("../fixtures/", import.meta.url).pathname,
};
const fetched = (name: string) => [...OPEN_WEBCLAP_BUNDLES, ...TEST_PLUGINS].find((f) => f.name === name) as Fixture;
const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
};

// site/ as a static server, with or without the two cross-origin isolation headers (without them the pages rely
// on isolate(), as on GitHub Pages).
async function serve(isolated: boolean): Promise<{ server: Server; url: string }> {
    const server = createServer(async (request, response) => {
        const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
        const prefix = Object.keys(folders).find((p) => path.startsWith(p));
        const dir = prefix ? (folders[prefix] as string) : root;
        const file = join(dir, prefix ? path.slice(prefix.length) : path.endsWith("/") ? `${path}index.html` : path);
        if (!file.startsWith(dir)) return void response.writeHead(403).end();
        // The site has no icon: a 204 for the one Chrome asks for, since it logs a 404 as a console error. Under
        // isolate() this goes through the service worker, which once failed every body-less response.
        if (path === "/favicon.ico") return void response.writeHead(204).end();
        try {
            const cached = /^\/cache\/([\w-]+)\.wclap\.tar\.gz$/.exec(path)?.[1];
            const body = cached ? await fetchFixture(fetched(cached)) : await readFile(file);
            const headers: Record<string, string> = {
                "Content-Type": types[extname(file)] ?? "application/octet-stream",
            };
            if (isolated) {
                headers["Cross-Origin-Opener-Policy"] = "same-origin";
                headers["Cross-Origin-Embedder-Policy"] = "require-corp";
            }
            response.writeHead(200, headers).end(body);
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

// Runs in every page before its own scripts: whatever connects to a context's destination also feeds an analyser,
// and the loudest sample seen so far is kept in window.peak. An offline render's result is measured as it returns.
function listen() {
    const w = window as unknown as { peak: number };
    w.peak = 0;
    const analysers: AnalyserNode[] = [];
    const seen = new WeakMap<BaseAudioContext, AnalyserNode>();
    const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
        if (args[0] instanceof AudioDestinationNode && this.context instanceof AudioContext) {
            let analyser = seen.get(this.context);
            if (!analyser) {
                analyser = new AnalyserNode(this.context, { fftSize: 2048 });
                seen.set(this.context, analyser);
                analysers.push(analyser);
            }
            connect.call(this, analyser);
        }
        return connect.apply(this, args);
    } as typeof AudioNode.prototype.connect;
    const samples = new Float32Array(2048);
    setInterval(() => {
        for (const analyser of analysers) {
            analyser.getFloatTimeDomainData(samples);
            for (const v of samples) w.peak = Math.max(w.peak, Math.abs(v));
        }
    }, 20);
    const render = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = async function (this: OfflineAudioContext) {
        const audio = await render.call(this);
        for (let c = 0; c < audio.numberOfChannels; c++)
            for (const v of audio.getChannelData(c)) w.peak = Math.max(w.peak, Math.abs(v));
        return audio;
    };
}

let browser: Browser;
let isolated: { server: Server; url: string };
let plain: { server: Server; url: string };
before(async () => {
    [isolated, plain] = await Promise.all([serve(true), serve(false)]);
    browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
    await browser?.close();
    isolated?.server.close();
    plain?.server.close();
});

// A page in a fresh context (its own service workers and storage), its errors collected.
async function open(base: string, name: string): Promise<{ page: Page; errors: string[]; loads: () => number }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    let loads = 0;
    page.on("load", () => loads++);
    page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
    page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
    page.on("requestfailed", (r) => errors.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
    await page.addInitScript(listen);
    await page.goto(base + name);
    return { page, errors, loads: () => loads };
}

const status = (page: Page) => page.locator(".status");
const peak = (page: Page) => page.evaluate(() => (window as unknown as { peak: number }).peak);
// A key held on the page's piano, as its note-down event.
const play = (page: Page, note = 60) =>
    page.evaluate((note) => {
        document
            .querySelector("compost-piano")
            ?.dispatchEvent(new CustomEvent("note-down", { detail: { note }, bubbles: true }));
    }, note);

// Each page: what starts it, and whether it then needs a note to make sound.
const PAGES: [string, { button: string; note?: boolean }][] = [
    ["01-one-plugin.html", { button: "#start", note: true }],
    ["02-chain.html", { button: "#start", note: true }],
    ["03-ab.html", { button: "#start", note: true }],
    ["04-effect-and-automation.html", { button: "#start" }],
    ["05-midi.html", { button: "#start", note: true }],
    ["06-offline-render.html", { button: "#render" }],
    ["07-own-graph.html", { button: "#start" }],
    ["08-synth-in-a-window.html", { button: "#start", note: true }],
    ["09-rack.html", { button: "#start", note: true }],
];

for (const [name, how] of PAGES) {
    test(name, { timeout: 60000 }, async () => {
        const { page, errors } = await open(isolated.url, name);
        await page.click(how.button);
        // Every page writes its status line once it has loaded its plug-ins (06 once it has rendered).
        await status(page)
            .filter({ hasText: name.startsWith("06") ? "rendered" : /./ })
            .waitFor({ timeout: 45000 });
        if (how.note) await play(page);
        await page.waitForTimeout(2000);
        assert.ok((await peak(page)) > 1e-3, `silent: peak ${await peak(page)}`);
        assert.deepEqual(errors, []);
        await page.context().close();
    });
}

test("a plug-in's interface is shown in a frame", { timeout: 60000 }, async () => {
    const { page, errors } = await open(isolated.url, "01-one-plugin.html");
    await page.click("#start");
    const frame = page.frameLocator("#ui iframe");
    await frame.locator("body *").first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(1000);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("PICOH-101 runs its main-thread work on a Worker", { timeout: 60000 }, async () => {
    const { page, errors } = await open(isolated.url, "01-one-plugin.html");
    await page.click("#start");
    await status(page).filter({ hasText: "main-thread work on" }).waitFor({ timeout: 45000 });
    assert.match((await status(page).textContent()) ?? "", /on a Worker/);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("isolate(): without the headers, the service worker isolates the page after one reload", async () => {
    const { page, errors, loads } = await open(plain.url, "04-effect-and-automation.html");
    await page
        .waitForFunction(() => crossOriginIsolated, undefined, { timeout: 15000 })
        .catch(async () => {
            await page.waitForLoadState(); // the first page's context went away in its reload; ask the new one
            await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 15000 });
        });
    assert.equal(loads(), 2);
    await page.click("#start");
    await status(page).filter({ hasText: /./ }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    assert.ok((await peak(page)) > 1e-3, "silent");
    assert.deepEqual(errors, []);
    await page.context().close();
});

// The harness page (test/browser/harness.html), clicked once so an AudioContext may start, with the module loaded.
async function harness(): Promise<{ page: Page; errors: string[] }> {
    const { page, errors } = await open(isolated.url, "test/harness.html");
    await page.mouse.click(1, 1);
    await page.waitForFunction(() => "wclap" in window);
    return { page, errors };
}

// What the harness's tests reach on the page: the module, and a pause.
type Harness = { wclap: typeof import("wclap-ts"); sleep: (ms: number) => Promise<void> };

test("restoring a state brings the parameters back; a preset moves them", { timeout: 60000 }, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap, sleep } = window as unknown as Harness;
        const context = new AudioContext();
        const synth = await wclap.loadWclap(context, "/fixtures/PICOH-101.wclap.tar.gz");
        // Restoring state, the plug-in reports every parameter from the audio thread ("param"), and the page reads
        // them all back ("value" for each one it had otherwise); either way `values` ends up as the plug-in has them.
        const heard = new Map<number, number>();
        const hear = (e: CustomEvent<{ id: number; value: number }>) => heard.set(e.detail.id, e.detail.value);
        synth.addEventListener("param", hear);
        synth.addEventListener("value", hear);
        const saved = await synth.saveState();
        await synth.loadState(saved);
        const before = [...synth.values];
        synth.param(0, 50); // Tune, from 0, straight after the load: its late reports mustn't undo this
        await sleep(200);
        const tuned = synth.values.get(0);
        const changed = await synth.saveState();
        heard.clear();
        await synth.loadState(saved);
        const restored = { values: [...synth.values], heard: heard.get(0) };
        synth.removeEventListener("param", hear);
        synth.removeEventListener("value", hear);

        const drum = await wclap.loadWclap(context, "/fixtures/Tapa.wclap.tar.gz");
        const presets = await drum.presets();
        await drum.loadPreset(presets[0] as (typeof presets)[0]);
        const first = [...drum.values];
        heard.clear();
        drum.addEventListener("param", hear);
        drum.addEventListener("value", hear);
        await drum.loadPreset(presets[1] as (typeof presets)[0]);
        return {
            before,
            tuned,
            changed: changed.join() !== saved.join(),
            restored,
            first,
            second: [...drum.values],
            presetHeard: [...heard],
        };
    });
    assert.equal(r.tuned, 50, "a report from the load overwrote the parameter set after it");
    assert.ok(r.changed, "the parameter change didn't reach the plug-in's state");
    assert.deepEqual(r.restored.values, r.before);
    assert.equal(r.restored.heard, 0);
    const moved = r.second.filter(([id, v]) => new Map(r.first).get(id) !== v);
    assert.ok(moved.length > 0, "the second preset moved no parameter");
    for (const [id, v] of moved) assert.equal(new Map(r.presetHeard).get(id), v, `no event for parameter ${id}`);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("alignLatency delays the faster chain by the slower one's latency", { timeout: 60000 }, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap, sleep } = window as unknown as Harness;
        const context = new AudioContext();
        const slow = await wclap.createChain(context);
        const compressor = await slow.add("/cache/openrb-compressor.wclap.tar.gz"); // 92 frames at 48 kHz
        const fast = await wclap.createChain(context);
        await fast.add("/fixtures/HeadlessGain.wclap.tar.gz");
        const nodes = await wclap.alignLatency([slow, fast]);
        // A DelayNode nothing pulls doesn't compute its delayTime, so each goes to the speakers.
        for (const node of nodes.values()) node.connect(context.destination);
        const time = (chain: typeof slow) => nodes.get(chain)?.delayTime.value ?? Number.NaN;
        await sleep(300); // the delay glides to its new time
        const aligned = { slow: time(slow), fast: time(fast), latency: await compressor.latency() };
        (slow.plugins[0] as (typeof slow.plugins)[0]).enabled = false; // bypassed: no latency, aligned again
        await sleep(300);
        return { rate: context.sampleRate, aligned, bypassed: { slow: time(slow), fast: time(fast) } };
    });
    assert.equal(r.aligned.slow, 0);
    assert.ok(r.aligned.latency > 0, "the compressor reports a latency");
    assert.ok(
        Math.abs(r.aligned.fast - r.aligned.latency / r.rate) < 1e-6,
        `fast chain delayed ${r.aligned.fast * r.rate} frames, the compressor's latency is ${r.aligned.latency}`,
    );
    assert.ok(Math.abs(r.bypassed.fast) < 1e-6, `still delayed ${r.bypassed.fast * r.rate} frames after bypass`);
    assert.equal(r.bypassed.slow, 0);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("a full event queue drops a note-on but still delivers the note-off", { timeout: 60000 }, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap, sleep } = window as unknown as Harness;
        const context = new AudioContext();
        const synth = await wclap.loadWclap(context, "/fixtures/PICOH-101.wclap.tar.gz");
        const analyser = new AnalyserNode(context, { fftSize: 2048 });
        synth.connect(analyser);
        analyser.connect(context.destination);
        const samples = new Float32Array(2048);
        const level = async (ms: number) => {
            let peak = 0;
            for (const end = performance.now() + ms; performance.now() < end; await sleep(20)) {
                analyser.getFloatTimeDomainData(samples);
                for (const v of samples) peak = Math.max(peak, Math.abs(v));
            }
            return peak;
        };
        synth.noteOn(60, 0.8);
        const playing = await level(500);
        // With the audio thread stopped nothing is read, so the queue fills.
        await context.suspend();
        let filled = 0;
        while (synth.param(0, 0)) filled++;
        const noteOn = synth.noteOn(64, 0.8);
        const noteOff = synth.noteOff(60);
        await context.resume();
        await sleep(1500); // the note's release
        return { playing, filled, noteOn, noteOff, after: await level(300) };
    });
    assert.ok(r.playing > 1e-3, `silent before: ${r.playing}`);
    assert.ok(r.filled > 100, `queue took ${r.filled} events`);
    assert.equal(r.noteOn, false);
    assert.equal(r.noteOff, true);
    assert.ok(r.after < 1e-4, `the note hangs: peak ${r.after}`);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("notes from the page carry note IDs: overlapping notes end oldest first, and choke ends a key", {
    timeout: 60000,
}, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap } = window as unknown as Harness;
        // note-ids writes each note's ID + 1 on the frame it starts (left) and on the frame it ends (right).
        const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1024, sampleRate: 48000 });
        const plugin = await wclap.loadWclap(context, "/cache/note-ids.wclap.tar.gz");
        plugin.connect(context.destination);
        const at = (frame: number) => frame / context.sampleRate;
        plugin.noteOn(60, 1, at(100));
        plugin.noteOn(60, 1, at(200));
        plugin.noteOn(64, 1, at(300));
        plugin.noteOff(60, 0, at(400));
        plugin.choke(60, at(500));
        plugin.choke(64, at(600));
        const audio = await context.startRendering();
        await plugin.destroy();
        const marks = (c: number) => [...audio.getChannelData(c)].flatMap((v, i) => (v !== 0 ? [[i, v]] : []));
        return { started: marks(0), ended: marks(1) };
    });
    assert.deepEqual(r.started, [
        [100, 1],
        [200, 2],
        [300, 3],
    ]);
    assert.deepEqual(r.ended, [
        [400, 1],
        [500, 2],
        [600, 3],
    ]);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("the render plug-in renders offline on an OfflineAudioContext, faster than real time, and realtime on an AudioContext", {
    timeout: 60000,
}, async (t) => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap, sleep } = window as unknown as Harness;
        // render writes its render mode + 1 into every sample: 1 realtime, 2 offline.
        const values = (samples: Float32Array) => [...new Set(samples)];
        const offline = new OfflineAudioContext({ numberOfChannels: 1, length: 10 * 48000, sampleRate: 48000 });
        const plugin = await wclap.loadWclap(offline, "/cache/render.wclap.tar.gz");
        plugin.connect(offline.destination);
        const begin = performance.now();
        const audio = await offline.startRendering();
        const ms = performance.now() - begin;
        await plugin.destroy();
        const context = new AudioContext();
        const live = await wclap.loadWclap(context, "/cache/render.wclap.tar.gz");
        const analyser = new AnalyserNode(context, { fftSize: 2048 });
        live.connect(analyser);
        analyser.connect(context.destination);
        await sleep(300);
        const samples = new Float32Array(2048);
        analyser.getFloatTimeDomainData(samples);
        await live.destroy();
        await context.close();
        return { ms, offline: values(audio.getChannelData(0)), realtime: values(samples) };
    });
    t.diagnostic(`a 10 s offline render took ${r.ms.toFixed(0)} ms`);
    assert.deepEqual(r.offline, [2], "offline mode on every frame");
    assert.ok(r.ms < 5000, `${r.ms} ms`);
    assert.deepEqual(r.realtime, [1]);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("raw MIDI from the page: untimed calls are live, timed ones aren't, and notes reach a MIDI-dialect plug-in as MIDI", {
    timeout: 60000,
}, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap } = window as unknown as Harness;
        // midi-echo marks each event it receives: its CLAP event type + 1 on the left, its flags on the right.
        const context = new OfflineAudioContext({ numberOfChannels: 2, length: 1024, sampleRate: 48000 });
        const plugin = await wclap.loadWclap(context, "/cache/midi-echo.wclap.tar.gz", { lead: 100 / 48000 });
        plugin.connect(context.destination);
        const at = (frame: number) => frame / context.sampleRate;
        const sent = [
            plugin.midi([0xe0, 0, 64]), // now: frame 100, live
            plugin.midi([0x90, 60, 100], at(300)),
            plugin.midi([0xf0, 1, 2, 3, 0xf7], at(400)),
            plugin.midi([0xd0, 9, 9, 9], at(500)), // the first two bytes are the message
            plugin.midi([0x40, 1]), // no status byte: refused
        ];
        const audio = await context.startRendering();
        await plugin.destroy();
        const marks = (c: number) => [...audio.getChannelData(c)].flatMap((v, i) => (v !== 0 ? [[i, v]] : []));
        return { sent, types: marks(0), flags: marks(1) };
    });
    assert.deepEqual(r.sent, [true, true, true, true, false]);
    assert.deepEqual(r.types, [
        [100, 11], // CLAP_EVENT_MIDI
        [300, 11], // a note, as MIDI
        [400, 12], // CLAP_EVENT_MIDI_SYSEX
        [500, 11],
    ]);
    assert.deepEqual(r.flags, [[100, 1]], "only the untimed message is CLAP_EVENT_IS_LIVE");
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("Web MIDI: pitch bend, aftertouch and sysex reach the plug-in and come back out as midiout and to a MIDI output", {
    timeout: 60000,
}, async () => {
    const { page, errors } = await harness();
    const r = await page.evaluate(async () => {
        const { wclap, sleep } = window as unknown as Harness;
        // A fake Web MIDI: one input the test plays, one output that records what it's sent.
        const input = new EventTarget();
        const access = Object.assign(new EventTarget(), { inputs: new Map([["in", input]]) });
        const asked: unknown[] = [];
        Object.defineProperty(navigator, "requestMIDIAccess", {
            value: async (options: unknown) => {
                asked.push(options);
                return access;
            },
            configurable: true,
        });
        const play = (data: number[]) => {
            const e = new Event("midimessage");
            Object.defineProperty(e, "data", { value: Uint8Array.from(data) });
            Object.defineProperty(e, "timeStamp", { value: performance.now() });
            input.dispatchEvent(e);
        };
        const context = new AudioContext();
        const plugin = await wclap.loadWclap(context, "/cache/midi-echo.wclap.tar.gz");
        plugin.connect(new GainNode(context, { gain: 0 })).connect(context.destination);
        const out: number[][] = [];
        plugin.host.addEventListener("midiout", (e) => void out.push([...e.detail.data]));
        const device: number[][] = [];
        plugin.host.connectMidiOut({ send: (data: number[]) => void device.push([...data]) } as unknown as MIDIOutput);
        const stop = await plugin.connectMidi({ sysex: true });
        const messages = [
            [0xe3, 0x00, 0x60],
            [0xa3, 60, 90],
            [0xd3, 70],
            [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7],
            [0x93, 62, 100],
            [0x83, 62, 0],
        ];
        for (const m of messages) {
            play(m);
            await sleep(20);
        }
        await sleep(300);
        stop();
        await plugin.destroy();
        await context.close();
        return { asked, messages, out, device };
    });
    assert.deepEqual(r.asked, [{ sysex: true }]);
    assert.deepEqual(r.out, r.messages);
    assert.deepEqual(r.device, r.messages);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test("an interface whose URI has a query string loads in its frame", { timeout: 60000 }, async () => {
    const { page, errors } = await harness();
    const uri = await page.evaluate(async () => {
        const { wclap } = window as unknown as Harness;
        const context = new AudioContext();
        // Its webview names /index.html?device=compressor, and it has no clap.gui.
        const compressor = await wclap.loadWclap(context, "/cache/openrb-compressor.wclap.tar.gz");
        await compressor.showInterface(document.querySelector("#ui") as HTMLElement);
        return document.querySelector("#ui iframe")?.getAttribute("src");
    });
    assert.match(uri ?? "", /\?device=compressor$/);
    await page.frameLocator("#ui iframe").locator("body *").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    assert.deepEqual(errors, []);
    await page.context().close();
});
