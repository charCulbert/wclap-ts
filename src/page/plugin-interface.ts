// A plug-in's interface on the page: its own web page (CLAP's webview) in an iframe, or a generated panel of its
// parameters when it has none. The page's files come from the plug-in (webview's get_resource): the iframe loads
// <base>/ui/<token>/<path>, the service worker asks the pages, and this page answers for its own tokens. A plug-in
// that serves no files is served from its bundle instead.

import { CLAP_PARAM_IS_HIDDEN, CLAP_PARAM_IS_READONLY, CLAP_PARAM_IS_STEPPED } from "../plugin/clap.generated.ts";
import { bundleHash, cacheFiles, startWorker } from "./bundle-cache.ts";
import type { WclapPlugin } from "./wclap-plugin.ts";

const shown = new Map<WclapPlugin, { element: HTMLElement; close: () => void }>();
// Interfaces this page holds, by the token in their URL.
const served = new Map<string, WclapPlugin>();
let answering = false;

// Answers the service worker's requests for files of this page's interfaces.
function answerResources(): void {
    if (answering) return;
    answering = true;
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
        const m = event.data as { type?: string; token?: string; path?: string };
        const port = event.ports[0];
        if (m?.type !== "wclap-resource" || !port) return;
        const plugin = served.get(m.token ?? "");
        if (!plugin) return port.postMessage(null);
        void plugin
            .call({ call: "get-resource", path: m.path ?? "/" })
            .then((found) => (found ? port.postMessage(found, [found.bytes.buffer]) : port.postMessage(null)))
            .catch(() => port.postMessage(null));
    });
    navigator.serviceWorker.startMessages();
}
const cached = new Map<string, Promise<string>>();

// The bundle's files cached on this origin; returns their folder's URL.
function cacheBundle(plugin: WclapPlugin): Promise<string> {
    const base = plugin.host.base;
    const key = `${base}:${plugin.id}`;
    let work = cached.get(key);
    if (!work) {
        work = (async () => {
            await startWorker(base);
            return cacheFiles(base, await bundleHash(plugin.bundle.files), plugin.bundle.files);
        })();
        cached.set(key, work);
    }
    return work;
}

export async function showInterface(plugin: WclapPlugin, element: HTMLElement): Promise<void> {
    hideInterface(plugin);
    const info = await plugin.openInterface();
    if (!info) return showPanel(plugin, element);
    const external = /^[a-z][a-z0-9+.-]*:/i.test(info.uri);
    const isolated = external ? undefined : plugin.host.uiBase;
    // A path in the bundle; bundles from older builds keep their files in resources/.
    const path = info.uri.replace(/^\//, "");
    const entry =
        !external && !plugin.bundle.files.has(path) && plugin.bundle.files.has(`resources/${path}`)
            ? `resources/${path}`
            : path;
    const iframe = document.createElement("iframe");
    const tokens: string[] = [];
    let src = info.uri;
    if (isolated) {
        // On the interface origin, frame.html takes the files and becomes the interface. No top navigation.
        src = new URL("frame.html", isolated).href;
        iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-modals");
    } else if (!external && (await plugin.call({ call: "get-resource", path: info.uri }).catch(() => null))) {
        // The plug-in serves its own files.
        await startWorker(plugin.host.base);
        answerResources();
        const token = crypto.randomUUID();
        served.set(token, plugin);
        tokens.push(token);
        src = new URL(`ui/${token}${info.uri.startsWith("/") ? "" : "/"}${info.uri}`, plugin.host.base).href;
    } else if (!external) src = new URL(entry, await cacheBundle(plugin)).href;
    iframe.title = plugin.descriptor.name;
    iframe.style.border = "0";
    iframe.style.display = "block";
    // The interface's own size, scaled down only if it doesn't fit and can't be resized.
    let current = { width: info.width || 640, height: info.height || 400 };
    const size = (width: number, height: number) => {
        current = { width: width || 640, height: height || 400 };
        iframe.width = String(current.width);
        iframe.height = String(current.height);
        const scale = Math.min(1, element.clientWidth / current.width);
        iframe.style.transformOrigin = "0 0";
        iframe.style.transform = scale < 1 ? `scale(${scale})` : "";
        element.style.height = `${current.height * scale}px`;
    };
    // A resizable interface (CLAP's gui.can_resize) is asked for the size that fits the space, keeping its shape,
    // and lays itself out at that size; it's asked again whenever the space changes.
    let fitting = false;
    const fit = async () => {
        const width = Math.floor(element.clientWidth);
        if (!info.resizable || fitting || width <= 0 || width === current.width)
            return size(current.width, current.height);
        fitting = true;
        try {
            const height = Math.round((current.height * width) / current.width);
            const got = await plugin.call({ call: "resize-interface", width, height }).catch(() => null);
            size(got?.width ?? current.width, got?.height ?? current.height);
        } finally {
            fitting = false;
        }
    };
    const observer = new ResizeObserver(() => void fit());
    const origin = new URL(src).origin;
    const fromPage = async (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow || event.origin !== origin) return;
        const data = event.data;
        if (isolated && data === "wclap-frame-ready") {
            const files = [...plugin.bundle.files];
            const open = { hash: await bundleHash(files), files, entry };
            iframe.contentWindow?.postMessage(open, origin);
            return;
        }
        const bytes =
            data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : ArrayBuffer.isView(data)
                  ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
                  : typeof data === "string"
                    ? new TextEncoder().encode(data)
                    : undefined;
        if (bytes) void plugin.call({ call: "interface-message", bytes });
    };
    plugin.toInterface = (bytes) => {
        const buffer = bytes.slice().buffer;
        iframe.contentWindow?.postMessage(buffer, origin, [buffer]);
    };
    plugin.onInterfaceRequest = (request, width, height) => {
        if (request === "resize" && width && height) size(width, height);
    };
    observer.observe(element);
    const listener = (event: MessageEvent) => void fromPage(event);
    addEventListener("message", listener);
    size(info.width, info.height);
    void fit();
    iframe.src = src;
    element.replaceChildren(iframe);
    shown.set(plugin, {
        element,
        close: () => {
            for (const token of tokens) served.delete(token);
            observer.disconnect();
            removeEventListener("message", listener);
            plugin.toInterface = undefined;
            void plugin.call({ call: "close-interface" }).catch(() => undefined);
        },
    });
}

// A control per parameter: a slider, or steps for stepped ones, showing the plug-in's own value text.
function showPanel(plugin: WclapPlugin, element: HTMLElement): void {
    const panel = document.createElement("div");
    panel.className = "wclap-panel";
    const follow = new Map<number, (value: number) => void>();
    for (const p of plugin.params) {
        if (p.flags & CLAP_PARAM_IS_HIDDEN) continue;
        const row = document.createElement("label");
        const name = document.createElement("span");
        const input = document.createElement("input");
        const text = document.createElement("output");
        name.textContent = p.name;
        input.type = "range";
        input.min = String(p.min);
        input.max = String(p.max);
        input.step = p.flags & CLAP_PARAM_IS_STEPPED ? "1" : String((p.max - p.min) / 1000 || "any");
        input.value = String(plugin.values.get(p.id) ?? p.default);
        input.disabled = (p.flags & CLAP_PARAM_IS_READONLY) !== 0;
        const label = async () => {
            text.textContent = (await plugin.valueText(p.id, Number(input.value))) ?? input.value;
        };
        input.oninput = () => {
            plugin.param(p.id, Number(input.value));
        };
        follow.set(p.id, (value) => {
            input.value = String(value);
            void label();
        });
        void label();
        row.append(name, input, text);
        panel.append(row);
    }
    element.replaceChildren(panel);
    const listener = (e: CustomEvent<{ id: number; value: number }>) => follow.get(e.detail.id)?.(e.detail.value);
    plugin.addEventListener("param", listener);
    plugin.addEventListener("value", listener);
    shown.set(plugin, {
        element,
        close: () => {
            plugin.removeEventListener("param", listener);
            plugin.removeEventListener("value", listener);
        },
    });
}

export function hideInterface(plugin: WclapPlugin): void {
    const s = shown.get(plugin);
    if (!s) return;
    s.close();
    s.element.replaceChildren();
    shown.delete(plugin);
}
