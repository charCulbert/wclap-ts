// The service worker: serves plug-ins' interface files, and adds the cross-origin isolation headers shared memory
// needs to every same-origin response, for hosts that can't send them (GitHub Pages). An interface's files come
// from the plug-in itself (CLAP webview's get_resource), asked through the page that holds it: a request for
// .../ui/<token>/<path> goes to whichever page answers for <token>. Files a page put in the cache (an older
// arrangement, and the isolated origin's) are served from there. Bundled on its own; it must be served from the
// page's folder or above to isolate the page.
const sw = globalThis as unknown as {
    addEventListener(type: string, listener: (event: never) => void): void;
    skipWaiting(): Promise<void>;
    clients: {
        claim(): Promise<void>;
        matchAll(options: {
            type: string;
            includeUncontrolled: boolean;
        }): Promise<{ postMessage(m: unknown, t: Transferable[]): void }[]>;
    };
    location: Location;
};
interface FetchEvent {
    request: Request;
    respondWith(response: Promise<Response>): void;
}
interface ExtendableEvent {
    waitUntil(promise: Promise<unknown>): void;
}

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event: ExtendableEvent) => event.waitUntil(sw.clients.claim()));
sw.addEventListener("fetch", (event: FetchEvent) => {
    if (event.request.method !== "GET" || new URL(event.request.url).origin !== sw.location.origin) return;
    const path = new URL(event.request.url).pathname;
    // A bundle's files are cached by name alone; an interface may be opened with a query (index.html?device=...).
    const bundled = path.includes("/bundles/");
    event.respondWith(
        (async () => {
            const response =
                (await fromPlugin(event.request.url)) ??
                (await caches.match(event.request, { ignoreSearch: bundled })) ??
                (await fetch(event.request));
            if (!response.status) return response;
            const headers = new Headers(response.headers);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            // Interface files may be embedded from another origin (ChainOptions.uiBase); everything else stays home.
            const shared = bundled || path.includes("/ui/");
            headers.set("Cross-Origin-Resource-Policy", shared ? "cross-origin" : "same-origin");
            // A 204 or 304 can't be given a body, not even an empty one: the Response constructor throws.
            const body = [101, 103, 204, 205, 304].includes(response.status) ? null : response.body;
            return new Response(body, { status: response.status, statusText: response.statusText, headers });
        })(),
    );
});

// A file the plug-in serves, asked of every page until the one holding the plug-in answers; undefined when the URL
// isn't a plug-in's, a 404 when no page has that plug-in or the plug-in has no such file.
async function fromPlugin(url: string): Promise<Response | undefined> {
    // Under any folder: this worker may be the page's own (isolate()) rather than the one in base, so it can't
    // assume where base is.
    const match = /\/ui\/([0-9a-f-]{36})(\/[^?#]*)/.exec(new URL(url).pathname);
    if (!match) return undefined;
    const token = match[1] ?? "";
    let path: string;
    try {
        path = decodeURIComponent(match[2] ?? "/");
    } catch {
        return new Response("not found", { status: 404 });
    }
    const pages = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const answer = await new Promise<{ mime: string; bytes: Uint8Array } | null>((resolve) => {
        let waiting = pages.length;
        if (!waiting) resolve(null);
        setTimeout(() => resolve(null), 10000);
        for (const page of pages) {
            const channel = new MessageChannel();
            channel.port1.onmessage = ({ data }) => {
                if (data) resolve(data);
                else if (--waiting === 0) resolve(null);
            };
            page.postMessage({ type: "wclap-resource", token, path }, [channel.port2]);
        }
    });
    if (!answer) return new Response("not found", { status: 404 });
    return new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "Content-Type": answer.mime || "application/octet-stream" },
    });
}
