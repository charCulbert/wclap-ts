// Stores a plug-in bundle's interface files in Cache Storage under <base>bundles/<hash>/, where sw.js serves them.
const types: Record<string, string> = {
    html: "text/html",
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    woff2: "font/woff2",
    wasm: "application/wasm",
};

export type Files = Iterable<[string, Uint8Array]>;

// Names and contents, so a rebuild with files of the same sizes still gets a fresh folder.
export async function bundleHash(files: Files): Promise<string> {
    const parts: BlobPart[] = [];
    for (const [name, data] of files) parts.push(`${name}:${data.length}:`, data as Uint8Array<ArrayBuffer>);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer()));
    return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Registers base/sw.js (or `base` itself with a file name) and waits for that registration itself:
// `serviceWorker.ready` only resolves when the worker's scope covers the calling page, which it needn't.
export async function startWorker(base: URL, file = "sw.js"): Promise<void> {
    const url = new URL(file, base);
    const registration = await navigator.serviceWorker.register(url, { scope: new URL(".", url).pathname });
    const worker = registration.installing ?? registration.waiting;
    if (!registration.active && worker)
        await new Promise<void>((resolve) =>
            worker.addEventListener("statechange", () => worker.state === "activated" && resolve()),
        );
}

// Returns the bundle folder's URL.
export async function cacheFiles(base: URL, hash: string, files: Files): Promise<string> {
    const folder = new URL(`bundles/${hash}/`, base).href;
    const cache = await caches.open("wclap-ts");
    await Promise.all(
        [...files].map(([name, data]) =>
            cache.put(
                new URL(name, folder).href,
                new Response(data as Uint8Array<ArrayBuffer>, {
                    headers: { "Content-Type": types[name.split(".").pop() ?? ""] ?? "application/octet-stream" },
                }),
            ),
        ),
    );
    return folder;
}
