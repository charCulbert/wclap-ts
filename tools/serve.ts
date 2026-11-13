// Serves this folder with cross-origin isolation, which shared memory needs: `node tools/serve.ts [port]`.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.argv[2] ?? 8150);
const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
};

createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const file = resolve(root, `.${normalize(path.endsWith("/") ? `${path}index.html` : path)}`);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    // frame.html is embedded from the other origin when interfaces are isolated (ChainOptions.uiBase).
    response.setHeader("Cross-Origin-Resource-Policy", path.endsWith("/frame.html") ? "cross-origin" : "same-origin");
    response.setHeader("Cache-Control", "no-store");
    if (!file.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
    }
    try {
        const body = await readFile(file);
        response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
        response.writeHead(404).end();
    }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/examples/`));
