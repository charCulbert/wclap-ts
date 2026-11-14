import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { openBundle } from "../src/plugin/wclap-bundle.ts";

// A module with one memory (imported or declared) starting at `initial` pages.
function wasm(initial: number, imported: boolean): Uint8Array {
    const limits = [0x00, initial]; // no maximum; initial < 128
    const section = imported
        ? [2, 3 + 1 + 1 + 1 + limits.length, 1, 1, 0x6d, 1, 0x6d, 2, ...limits]
        : [5, 1 + limits.length, 1, ...limits];
    return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section]);
}

function tar(entries: [string, Uint8Array][]): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [name, data] of entries) {
        const header = new Uint8Array(512);
        header.set(new TextEncoder().encode(name));
        header.set(new TextEncoder().encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
        header[156] = "0".charCodeAt(0);
        parts.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
    }
    parts.push(new Uint8Array(1024));
    return gzipSync(Buffer.concat(parts));
}

const good = wasm(2, true);

test("a small bundle loads", async () => {
    const bundle = await openBundle(
        tar([
            ["module.wasm", good],
            ["res/a.txt", new Uint8Array(10)],
        ]),
    );
    assert.equal(bundle.files.get("res/a.txt")?.length, 10);
});

test("a path with .. is refused", async () => {
    for (const name of ["../x", "a/../../x"])
        await assert.rejects(
            openBundle(
                tar([
                    ["module.wasm", good],
                    [name, new Uint8Array(1)],
                ]),
            ),
            /unsafe path/,
        );
});

test("an absolute path is refused", async () => {
    const bytes = tar([
        ["module.wasm", good],
        ["/abs", new Uint8Array(1)],
    ]);
    await assert.rejects(openBundle(bytes), /unsafe path/);
});

test("a bundle unpacking past maxUnpackedBytes is refused", async () => {
    const bytes = tar([
        ["module.wasm", good],
        ["big", new Uint8Array(1 << 20)],
    ]);
    await assert.rejects(openBundle(bytes, { maxUnpackedBytes: 1 << 16 }), /maxUnpackedBytes/);
    await openBundle(bytes);
});

test("a resource past maxFileBytes is refused", async () => {
    const bytes = tar([
        ["module.wasm", good],
        ["ui/big.js", new Uint8Array(5000)],
    ]);
    await assert.rejects(openBundle(bytes, { maxFileBytes: 4096 }), /maxFileBytes/);
    await openBundle(bytes);
});

test("a memory starting above maxMemoryMB is refused, imported or declared", async () => {
    for (const imported of [true, false]) {
        const bytes = tar([["module.wasm", wasm(100, imported)]]);
        await assert.rejects(openBundle(bytes, { maxMemoryMB: 1 }), /maxMemoryMB/);
        await openBundle(bytes, { maxMemoryMB: 7 });
    }
});
