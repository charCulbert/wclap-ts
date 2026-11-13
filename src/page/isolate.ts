import { startWorker } from "./bundle-cache.ts";

// Makes the page cross-origin isolated where its server can't send the headers (GitHub Pages, say): registers the
// service worker, which adds them, and reloads the page once. `sw` must be in the page's folder or above, since a
// service worker only reaches pages under it: `npx wclap-ts setup --sw <page folder>` puts it there.
// Resolves true once the page is isolated; false if it can't be (no service workers, or the reload didn't help).
export async function isolate(sw: string | URL = "wclap-sw.js"): Promise<boolean> {
    const key = "wclap-ts:isolate";
    if (globalThis.crossOriginIsolated) {
        try {
            sessionStorage.removeItem(key);
        } catch {}
        return true;
    }
    if (!("serviceWorker" in navigator)) return false;
    await startWorker(new URL(sw, location.href), "");
    try {
        if (sessionStorage.getItem(key)) return false;
        sessionStorage.setItem(key, "1");
    } catch {
        return false;
    }
    location.reload();
    return new Promise(() => undefined);
}
