// A thread the plug-in started, in a Node worker: what dist/thread.js does in a browser Worker.
import { parentPort, workerData } from "node:worker_threads";
import { runThread, type ThreadStart } from "../src/threads/plugin-spawned-threads.ts";

const post = (message: unknown) => parentPort?.postMessage(message);
runThread(
    workerData as ThreadStart,
    (text) => post({ type: "log", text }),
    (start) => post({ type: "spawn", start }),
);
post({ type: "exit" });
