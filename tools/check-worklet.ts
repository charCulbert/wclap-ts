// Fails if the code that runs inside the AudioWorklet uses what an AudioWorkletGlobalScope doesn't have.
// Bundles src/runtime/worklet.ts and searches it; `npm run check` runs this.
import { execFileSync } from "node:child_process";

// Timers are left out: the only ones are in the control block's Worker-side wait, which the worklet never calls.
const missing = ["TextEncoder", "TextDecoder", "fetch(", "performance.now", "document."];
const code = execFileSync("npx", ["esbuild", "src/runtime/worklet.ts", "--bundle", "--format=esm"], {
    encoding: "utf8",
});
const found = missing.filter((name) => code.includes(name));
if (found.length) {
    console.error(`the AudioWorklet's code uses ${found.join(", ")}, which an AudioWorklet doesn't have`);
    process.exit(1);
}
