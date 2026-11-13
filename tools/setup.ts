// `npx wclap-ts setup [folder] [--sw <page folder>]`. A folder gets the files wclap-ts runs from, for a site that
// serves them from somewhere other than beside the library (ChainOptions.base names it). --sw copies the service
// worker next to your pages as wclap-sw.js, for isolate() on hosts that can't send the cross-origin isolation
// headers. Either, or both.
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["worklet.js", "worker.js", "thread.js", "sw.js", "frame.html", "frame.js"];
const [command, ...rest] = process.argv.slice(2);
const swAt = rest.indexOf("--sw");
const sw = swAt >= 0 ? rest[swAt + 1] : undefined;
const folder = rest.find((arg, i) => arg !== "--sw" && i !== swAt + 1);
if (command !== "setup" || (!folder && !sw) || (swAt >= 0 && !sw)) {
    console.log("usage: wclap-ts setup [folder] [--sw <page folder>]");
    process.exit(command ? 1 : 0);
}
const dist = fileURLToPath(new URL(".", import.meta.url));
if (folder) {
    const target = resolve(folder);
    await mkdir(target, { recursive: true });
    for (const file of FILES) await copyFile(join(dist, file), join(target, file));
    console.log(`copied ${FILES.join(", ")} to ${target}: pass base: "/<its path>/" to createChain or loadWclap`);
}
if (sw) {
    await copyFile(join(dist, "sw.js"), join(resolve(sw), "wclap-sw.js"));
    console.log(`copied sw.js to ${join(resolve(sw), "wclap-sw.js")}: call isolate() before createChain or loadWclap`);
}
