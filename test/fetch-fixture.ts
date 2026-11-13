// Test bundles that aren't ours are fetched from their source, pinned by commit and checksum, and cached in .cache/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// A note sequencer (CC0-1.0) from github.com/andremichelle/open-webclap. See fixtures/README.
export const HIVE = {
    url: "https://raw.githubusercontent.com/andremichelle/open-webclap/b430912ae8fa21b42b10ab6d0bf22c6c541c7c36/site/public/bundled/hive.wclap.tar.gz",
    sha256: "e0061f4cd42783d127856dec95f2aac50a742712c26f0a0623ba78a886451d62",
};

export async function fetchFixture({ url, sha256 }: { url: string; sha256: string }): Promise<Uint8Array> {
    const cached = new URL(`../.cache/${sha256}`, import.meta.url);
    const check = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") === sha256;
    try {
        const bytes = readFileSync(cached);
        if (check(bytes)) return bytes;
    } catch {}
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!check(bytes)) throw new Error(`${url}: the checksum doesn't match`);
    mkdirSync(new URL("../.cache/", import.meta.url), { recursive: true });
    writeFileSync(cached, bytes);
    return bytes;
}
