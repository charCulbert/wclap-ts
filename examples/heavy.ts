// HeavyMain for 3 s, its state loaded five times, with the audio thread's stats at the end. The measurement behind
// docs/threads.md; tools/bench.ts runs it in Chrome. Query: ?threads=one, or ?idle (HeadlessGain, no loads).
import { createChain, type Stats } from "../src/index.ts";
import { base, started, status } from "./shared.ts";

const query = new URLSearchParams(location.search);
const idle = query.has("idle");
const context = await started();
let stats: Stats | undefined;
const chain = await createChain(context, {
    base,
    threads: query.get("threads") === "one" ? "one" : "auto",
    onStats: (s) => {
        stats = { ...s };
    },
});
chain.connect(context.destination);
const plugin = await chain.add(`/test/fixtures/${idle ? "HeadlessGain" : "HeavyMain"}.wclap.tar.gz`);
const state = await plugin.saveState();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

status("playing");
await wait(500);
for (let i = 0; i < 5 && !idle; i++) {
    await plugin.loadState(state);
    await wait(400);
}
await wait(1500); // stats arrive about once a second
const result = { threads: plugin.threads, ...(stats ?? { stalls: 0, worstGapMs: 0, worstRenderMs: 0 }) };
status(JSON.stringify(result));
Object.assign(window, { benchResult: result });
