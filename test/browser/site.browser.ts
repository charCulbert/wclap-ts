// The site's nine examples in Google Chrome: each page starts, plays, and logs no errors. Run by
// `npm run test:browser` (not `npm test`: it needs Chrome and the network, since most pages load their plug-ins from
// GitHub). Audio is checked only for not being silent; test/refs.test.ts compares exact output with saved
// references in Node, so it isn't repeated here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";

const root = new URL("../../site/", import.meta.url).pathname;
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
        const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
        if (!file.startsWith(root)) return void response.writeHead(403).end();
        // The site has no icon: a 204 for the one Chrome asks for, since it logs a 404 as a console error. Under
        // isolate() this goes through the service worker, which once failed every body-less response.
        if (path === "/favicon.ico") return void response.writeHead(204).end();
        try {
            const body = await readFile(file);
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
