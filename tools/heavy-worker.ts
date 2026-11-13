// The main side for tools/heavy.ts: Heavy Main's main-thread role, in a worker thread.
import { parentPort } from "node:worker_threads";
import { MainThread, type StartOptions } from "../src/threads/two-threads.ts";

const port = parentPort;
if (!port) throw new Error("run this as a worker thread");
let main: MainThread | undefined;

port.on("message", async (message: { start?: StartOptions; load?: Uint8Array; stop?: true }) => {
    if (message.start) {
        const result = MainThread.start(message.start, { log: () => undefined });
        main = result.main;
        void main.serve();
        port.postMessage({ started: result.started, state: main.plugin.saveState() });
    } else if (message.load && main) {
        const begin = performance.now();
        main.plugin.loadState(message.load);
        port.postMessage({ loaded: performance.now() - begin });
    } else if (message.stop && main) {
        port.postMessage({ stopped: await main.stop() });
    }
});
