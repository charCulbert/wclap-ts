// The docs/threads.md table, measured in Chrome: examples/heavy.html on two threads (twice), on one thread, and an
// idle chain. Needs Google Chrome and a build (`npm run bench` does both). `node tools/bench.ts [--headed]`
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 8151;
const server = spawn(process.execPath, [new URL("serve.ts", import.meta.url).pathname, String(port)], {
    stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 500));
const browser = await chromium.launch({
    channel: "chrome",
    headless: !process.argv.includes("--headed"),
    args: ["--autoplay-policy=no-user-gesture-required"],
});

interface Result {
    threads: string;
    stalls: number;
    worstGapMs: number;
    worstRenderMs: number;
}
const run = async (query: string): Promise<Result> => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/examples/heavy.html${query}`);
    await page.click("#start");
    await page.waitForFunction(() => "benchResult" in window, undefined, { timeout: 30000 });
    const result = (await page.evaluate(() => (window as unknown as { benchResult: Result }).benchResult)) as Result;
    await page.close();
    return result;
};

await run(""); // a warm-up: the first page compiles everything
const rows: [string, Result][] = [
    ["Two threads, run 1", await run("")],
    ["Two threads, run 2", await run("")],
    ["One thread", await run("?threads=one")],
    ["An idle chain (HeadlessGain, no loads)", await run("?idle")],
];
const adds = [await run("?add"), await run("?add"), await run("?add")].map((r) => Math.round(r.worstGapMs));
await browser.close();
server.kill();

console.log(`Chrome ${browser.version()}, 128-frame blocks\n`);
console.log("| | Stalls (gaps over 20 ms) | Longest gap between blocks | Longest block |");
console.log("| --- | --- | --- | --- |");
for (const [name, r] of rows) {
    if (name.startsWith("Two") && r.threads !== "two") throw new Error(`${name} ran on ${r.threads} thread(s)`);
    const block = r.worstRenderMs <= 1 ? "1 ms or less" : `${r.worstRenderMs} ms`;
    console.log(`| ${name} | ${r.stalls} | ${Math.round(r.worstGapMs)} ms | ${block} |`);
}
console.log(`\nAdding PICOH-101 on the audio thread to a playing chain, longest gap: ${adds.join(", ")} ms`);
