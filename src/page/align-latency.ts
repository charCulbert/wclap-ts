import type { WclapHost } from "./wclap-host.ts";

// Latency compensation for chains played side by side (tracks): each chain but the slowest is delayed by the
// difference, to the sample. Connect each chain through its node in the result; call again when a chain changes.
// Calling it again reuses each chain's DelayNode and only changes its time. It runs again by itself when a plug-in
// in any of the chains reports a new latency.
const aligners = new WeakMap<WclapHost, DelayNode>();
const following = new WeakMap<WclapHost, () => void>();
let alignRuns = 0;
const latestRun = new WeakMap<WclapHost, number>();
const MAX_ALIGN = 2; // seconds; more latency than this between tracks isn't worth compensating
export async function alignLatency(chains: WclapHost[]): Promise<Map<WclapHost, DelayNode>> {
    for (const chain of chains) {
        const previous = following.get(chain);
        if (previous) chain.removeEventListener("latencychange", previous);
        const follow = () => void alignLatency(chains);
        chain.addEventListener("latencychange", follow);
        following.set(chain, follow);
    }
    const run = ++alignRuns;
    for (const chain of chains) latestRun.set(chain, run);
    const latencies = await Promise.all(chains.map((c) => c.latency()));
    const result = new Map<WclapHost, DelayNode>();
    const slowest = Math.max(0, ...latencies);
    chains.forEach((chain, i) => {
        const delay = (slowest - (latencies[i] ?? 0)) / chain.context.sampleRate;
        let node = aligners.get(chain);
        if (!node) {
            node = new DelayNode(chain.context, { maxDelayTime: MAX_ALIGN });
            chain.connect(node);
            aligners.set(chain, node);
        }
        // A later call may have finished first, with newer latencies: it wins. Glides there, so a change doesn't
        // click (it bends pitch for a moment instead).
        if (latestRun.get(chain) === run)
            node.delayTime.setTargetAtTime(Math.min(delay, MAX_ALIGN), chain.context.currentTime, 0.02);
        result.set(chain, node);
    });
    return result;
}
