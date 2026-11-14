// The Worker: CLAP's main-thread role for every plug-in on the page that runs on two threads. Bundled on its own
// and started by the page.
import { type FromMain, type MainCall, mainCall } from "../threads/main-thread-calls.ts";
import type { ThreadStart } from "../threads/plugin-spawned-threads.ts";
import { MainThread, type Started, type StartOptions } from "../threads/two-threads.ts";

export type ToWorker =
    | { type: "add"; id: number; options: StartOptions }
    | { type: "remove"; id: number; audioDone?: boolean }
    | { type: "call"; id: number; callId: number; call: MainCall };

export type FromWorker =
    | FromMain
    | { type: "added"; id: number; started: Started }
    | { type: "removed"; id: number; clean: boolean }
    | { type: "result"; callId: number; value: unknown }
    | { type: "error"; message: string; id?: number; callId?: number };

const scope = globalThis as unknown as {
    onmessage: (message: MessageEvent<ToWorker>) => void;
    postMessage(message: FromWorker, transfer?: Transferable[]): void;
};
const send = (message: FromWorker, transfer?: Transferable[]) => scope.postMessage(message, transfer);
const plugins = new Map<number, MainThread>();

scope.onmessage = async ({ data }) => {
    try {
        if (data.type === "add") {
            const id = data.id;
            const spawn = (start: ThreadStart) => send({ type: "spawn", id, start });
            const { main, started } = MainThread.start(
                data.options,
                {
                    log: (text, severity) => send({ type: "log", id, text, severity }),
                    onInterfaceMessage: (bytes) => send({ type: "interface-message", id, bytes }, [bytes.buffer]),
                    onInterfaceRequest: (request, width, height) => {
                        send({ type: "interface-request", id, request, ...(width ? { width, height } : {}) });
                        return true;
                    },
                    onChange: (what) => send({ type: "changed", id, what }),
                    onSuggestPage: (pageId) => send({ type: "suggest-page", id, pageId }),
                },
                spawn,
            );
            plugins.set(id, main);
            void main.serve();
            send({ type: "added", id, started });
            return;
        }
        const main = plugins.get(data.id);
        if (!main) throw new Error(`no plug-in ${data.id}`);
        if (data.type === "remove") {
            plugins.delete(data.id);
            send({ type: "removed", id: data.id, clean: await main.stop(2000, data.audioDone) });
            return;
        }
        main.check();
        const call = data.call;
        const value =
            call.call === "set-port-active"
                ? await main.setPortActive(call.input, call.index, call.active)
                : mainCall(main.plugin, call);
        send({ type: "result", callId: data.callId, value });
        main.plugin.idle();
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        send({ type: "error", message, id: data.id, ...("callId" in data ? { callId: data.callId } : {}) });
    }
};
