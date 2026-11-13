// A plain static server for this folder: `npm start`. It tells the browser not to cache, so edits show on reload,
// and it deliberately sends no cross-origin isolation headers, so the pages rely on isolate(), as they would on
// GitHub Pages.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/gzip", ".wasm": "application/wasm" };

createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
    const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(root)) return void response.writeHead(403).end();
    try {
        const body = await readFile(file);
        response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
        response.end(body);
    } catch {
        response.writeHead(404).end();
    }
}).listen(8160, "127.0.0.1", () => console.log("http://127.0.0.1:8160/"));
