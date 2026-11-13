// frame.html's script, on the interface origin: caches the bundle files the page sends, then becomes the plug-in's
// interface. The interface then runs on this origin, so it can't reach the page that embeds it.
import { cacheFiles, type Files, startWorker } from "../page/bundle-cache.ts";

interface Open {
    hash: string;
    files: Files;
    entry: string;
}

addEventListener("message", async (event: MessageEvent<Open>) => {
    if (event.source !== parent || !event.data?.files) return;
    const base = new URL(".", location.href);
    await startWorker(base);
    const folder = await cacheFiles(base, event.data.hash, event.data.files);
    location.replace(new URL(event.data.entry.replace(/^\//, ""), folder));
});
parent.postMessage("wclap-frame-ready", "*");
