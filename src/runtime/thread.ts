// thread.js: one thread a plug-in started, in its own Worker. The page starts it with the plug-in's ThreadStart and
// relays the threads it starts in turn.
import type { LogSeverity } from "../plugin/plugin-types.ts";
import { runThread, type ThreadStart } from "../threads/plugin-spawned-threads.ts";

export type FromThread =
    | { type: "log"; text: string; severity: LogSeverity }
    | { type: "spawn"; start: ThreadStart }
    | { type: "exit"; error?: string };

const post = (message: FromThread) => postMessage(message);
addEventListener("message", ({ data }: MessageEvent<ThreadStart>) => {
    try {
        runThread(
            data,
            (text, severity) => post({ type: "log", text, severity }),
            (start) => post({ type: "spawn", start }),
        );
        post({ type: "exit" });
    } catch (error) {
        post({ type: "exit", error: String(error) });
    }
});
