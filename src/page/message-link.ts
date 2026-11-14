import type { FromWorker, ToWorker } from "../runtime/worker.ts";
import type { MainCall } from "../threads/main-thread-calls.ts";
import type { FromProcessor, ToProcessor } from "../worklet/worklet-host.ts";
import type { WclapPlugin } from "./wclap-plugin.ts";

export type Source = string | URL | Uint8Array;
export type Message = FromWorker | FromProcessor;

export const nextPluginId = (() => {
    let next = 1;
    return () => next++;
})();
export const plugins = new Map<number, WclapPlugin>();
export const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

// A Worker or the AudioWorklet's port, with replies matched to requests.
export class Link {
    readonly #post: (message: unknown, transfer?: Transferable[]) => void;
    readonly #waiting: { test: (m: Message) => boolean; resolve: (m: Message) => void; reject: (e: Error) => void }[] =
        [];
    #nextCall = 1;
    onOther: (m: Message) => void = () => undefined;

    constructor(target: Worker | MessagePort) {
        this.#post = (message, transfer) => target.postMessage(message, transfer ?? []);
        target.onmessage = ({ data }: MessageEvent<Message>) => this.#receive(data);
    }

    #receive(m: Message): void {
        const i = this.#waiting.findIndex((w) => w.test(m));
        const waiter = this.#waiting[i];
        if (waiter && i >= 0) {
            this.#waiting.splice(i, 1);
            if (m.type === "error") waiter.reject(new Error(m.message));
            else waiter.resolve(m);
            return;
        }
        // A plug-in logs while it starts, before the page knows it: those lines go to the chain.
        if (
            m.type === "log" ||
            m.type === "interface-message" ||
            m.type === "interface-request" ||
            m.type === "changed" ||
            m.type === "suggest-page"
        ) {
            const plugin = plugins.get(m.id);
            if (plugin) plugin.receive(m);
            else this.onOther(m);
        } else this.onOther(m);
    }

    post(message: ToWorker | ToProcessor, transfer?: Transferable[]): void {
        this.#post(message, transfer);
    }

    // Sends and waits for the reply: the message `test` matches, or an error for the same plug-in or call.
    request<T extends Message>(message: ToWorker | ToProcessor, test: (m: Message) => boolean): Promise<T> {
        const id = "id" in message ? message.id : undefined;
        const callId = "callId" in message ? message.callId : undefined;
        return new Promise((resolve, reject) => {
            this.#waiting.push({
                test: (m) =>
                    test(m) || (m.type === "error" && (callId !== undefined ? m.callId === callId : m.id === id)),
                resolve: (m) => resolve(m as T),
                reject,
            });
            this.post(message);
        });
    }

    call(id: number, call: MainCall): Promise<unknown> {
        const callId = this.#nextCall++;
        return this.request<Extract<Message, { type: "result" }>>(
            { type: "call", id, callId, call },
            (m) => m.type === "result" && m.callId === callId,
        ).then((m) => m.value);
    }
}

export const fetchBytes = async (source: Source) =>
    source instanceof Uint8Array ? source : new Uint8Array(await (await fetch(source)).arrayBuffer());
