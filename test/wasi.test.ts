import assert from "node:assert/strict";
import { test } from "node:test";
import { wasiImports } from "../src/plugin/wasi-imports.ts";
import { Wasm } from "../src/plugin/wasm-struct.ts";

type Call = (...args: Array<number | bigint>) => number;

const NAMES = [
    "fd_write",
    "fd_prestat_get",
    "fd_prestat_dir_name",
    "fd_fdstat_get",
    "fd_filestat_get",
    "path_filestat_get",
    "path_open",
    "fd_read",
    "fd_pread",
    "fd_seek",
    "fd_tell",
    "fd_readdir",
    "fd_close",
    "path_create_directory",
    "path_unlink_file",
];

// A module that imports the WASI functions, so wasiImports has something to answer (a [module, name] pair imports
// from another module). Its types are never used.
const moduleWith = (names: (string | [string, string])[]) => {
    const uleb = (value: number) => {
        const out: number[] = [];
        let rest = value;
        do {
            const byte = rest & 0x7f;
            rest >>>= 7;
            out.push(rest ? byte | 0x80 : byte);
        } while (rest);
        return out;
    };
    const str = (s: string) => {
        const bytes = [...new TextEncoder().encode(s)];
        return [...uleb(bytes.length), ...bytes];
    };
    const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
    const imports = names.flatMap((entry) => {
        const [from, name] = typeof entry === "string" ? ["wasi_snapshot_preview1", entry] : entry;
        return [...str(from), ...str(name), 0, 0];
    });
    return new WebAssembly.Module(
        new Uint8Array([
            0x00,
            0x61,
            0x73,
            0x6d,
            0x01,
            0x00,
            0x00,
            0x00,
            ...section(1, [1, 0x60, 0, 0]),
            ...section(2, [...uleb(names.length), ...imports]),
        ]),
    );
};

const setup = (files?: Map<string, Uint8Array>) => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasm = new Wasm(memory, new WebAssembly.Table({ element: "anyfunc", initial: 1 }));
    const lines: string[] = [];
    const api = wasiImports(
        moduleWith(NAMES),
        () => wasm,
        (line) => lines.push(line),
        files,
    ).wasi_snapshot_preview1 as unknown as Record<string, Call>;
    const put = (at: number, text: string) => {
        const bytes = new TextEncoder().encode(text);
        wasm.bytes.set(bytes, at);
        return bytes.length;
    };
    // One iovec at `at` pointing at a buffer of `length` bytes.
    const iovec = (at: number, buffer: number, length: number) => {
        wasm.view.setUint32(at, buffer, true);
        wasm.view.setUint32(at + 4, length, true);
    };
    // Opens a path under fd 3 and returns the new fd, or the errno as a negative number.
    const open = (path: string, oflags = 0, rights = 0n) => {
        const length = put(1024, path);
        const result = api.path_open?.(3, 0, 1024, length, oflags, rights, 0n, 0, 2048) ?? -1;
        return result === 0 ? wasm.view.getUint32(2048, true) : -result;
    };
    const read = (fd: number, length: number) => {
        iovec(3000, 4000, length);
        api.fd_read?.(fd, 3000, 1, 3100);
        return new TextDecoder().decode(wasm.bytes.subarray(4000, 4000 + wasm.view.getUint32(3100, true)));
    };
    return { api, wasm, lines, put, iovec, open, read };
};

const sample = () =>
    new Map<string, Uint8Array>([
        ["page/index.html", new TextEncoder().encode("hello world")],
        ["readme.txt", new TextEncoder().encode("hi")],
    ]);

test("without files, nothing is preopened and fd 1 still writes lines", () => {
    const { api, wasm, lines, put, iovec } = setup();
    assert.equal(api.fd_prestat_get?.(3, 0), 8);
    assert.equal(api.path_open?.(3, 0, 1024, 0, 0, 0n, 0n, 0, 2048), 8);
    iovec(100, 200, put(200, "one\ntwo"));
    assert.equal(api.fd_write?.(1, 100, 1, 300), 0);
    assert.deepEqual(lines, ["one"]);
    assert.equal(wasm.view.getUint32(300, true), 7);
});

test("fd 3 is a preopened directory named /plugin", () => {
    const { api, wasm } = setup(sample());
    assert.equal(api.fd_prestat_get?.(3, 0), 0);
    assert.equal(wasm.view.getUint8(0), 0);
    assert.equal(wasm.view.getUint32(4, true), 7);
    assert.equal(api.fd_prestat_dir_name?.(3, 100, 7), 0);
    assert.equal(new TextDecoder().decode(wasm.bytes.subarray(100, 107)), "/plugin");
    assert.equal(api.fd_prestat_get?.(4, 0), 8);
    assert.equal(api.fd_prestat_get?.(0, 0), 8);
});

test("a file opens, reads, seeks and closes", () => {
    const { api, wasm, open, read, iovec } = setup(sample());
    const fd = open("page/index.html");
    assert.equal(fd, 4);
    assert.equal(api.fd_fdstat_get?.(fd, 512), 0);
    assert.equal(wasm.view.getUint8(512), 4);
    assert.equal(read(fd, 5), "hello");
    assert.equal(api.fd_tell?.(fd, 600), 0);
    assert.equal(wasm.view.getBigUint64(600, true), 5n);

    assert.equal(api.fd_seek?.(fd, -5n, 1, 600), 0);
    assert.equal(wasm.view.getBigUint64(600, true), 0n);
    assert.equal(api.fd_seek?.(fd, -6n, 2, 600), 0);
    assert.equal(wasm.view.getBigUint64(600, true), 5n);
    assert.equal(read(fd, 20), " world");
    assert.equal(read(fd, 20), "", "the end of the file reads nothing");
    assert.equal(api.fd_seek?.(fd, -100n, 1, 600), 28, "a seek before the start is refused");

    iovec(3000, 4000, 4);
    assert.equal(api.fd_pread?.(fd, 3000, 1, 6n, 3100), 0);
    assert.equal(new TextDecoder().decode(wasm.bytes.subarray(4000, 4004)), "worl");
    assert.equal(api.fd_tell?.(fd, 600), 0);
    assert.equal(wasm.view.getBigUint64(600, true), 11n, "pread leaves the position alone");

    assert.equal(api.fd_close?.(fd), 0);
    assert.equal(api.fd_close?.(fd), 8);
    assert.equal(api.fd_read?.(fd, 3000, 1, 3100), 8);
});

test("the size of a file, by fd and by path", () => {
    const { api, wasm, open, put } = setup(sample());
    const fd = open("page/index.html");
    assert.equal(api.fd_filestat_get?.(fd, 4096), 0);
    assert.equal(wasm.view.getBigUint64(4096 + 32, true), 11n);
    assert.equal(wasm.view.getUint8(4096 + 16), 4);
    const length = put(1024, "readme.txt");
    assert.equal(api.path_filestat_get?.(3, 0, 1024, length, 4200), 0);
    assert.equal(wasm.view.getBigUint64(4200 + 32, true), 2n);
});

test("a directory is implied by the paths under it, and lists its entries", () => {
    const { api, wasm, open } = setup(sample());
    const fd = open(".");
    assert.equal(fd, 4);
    assert.equal(api.fd_read?.(fd, 3000, 1, 3100), 31);

    assert.equal(api.fd_readdir?.(fd, 5000, 1000, 0n, 3300), 0);
    const used = wasm.view.getUint32(3300, true);
    const names: string[] = [];
    const types: number[] = [];
    for (let at = 5000; at < 5000 + used; ) {
        const namlen = wasm.view.getUint32(at + 16, true);
        types.push(wasm.view.getUint8(at + 20));
        names.push(new TextDecoder().decode(wasm.bytes.subarray(at + 24, at + 24 + namlen)));
        at += 24 + namlen;
    }
    assert.deepEqual(names, ["page", "readme.txt"]);
    assert.deepEqual(types, [3, 4]);

    const sub = open("page");
    assert.equal(api.fd_fdstat_get?.(sub, 512), 0);
    assert.equal(wasm.view.getUint8(512), 3);
    assert.equal(open("page/index.html"), 6);
});

test("a missing file is NOENT, and a path can't leave the bundle", () => {
    const { open } = setup(sample());
    assert.equal(open("nope.txt"), -44);
    assert.equal(open("page/nope/x"), -44);
    assert.equal(open("readme.txt/x"), -54, "a file has no children");
    assert.equal(open("../secret"), -76);
    assert.equal(open("/etc/passwd"), -76);
});

test("writing, creating and truncating are refused", () => {
    const { api, open } = setup(sample());
    const CREAT = 1;
    const TRUNC = 8;
    const FD_WRITE = 1n << 6n;
    assert.equal(open("readme.txt", CREAT), -69);
    assert.equal(open("new.txt", CREAT), -69);
    assert.equal(open("readme.txt", TRUNC), -69);
    assert.equal(open("readme.txt", 0, FD_WRITE), -2);
    assert.equal(api.path_create_directory?.(3, 0, 0, 0), 69);
    assert.equal(api.path_unlink_file?.(3, 0, 0, 0), 69);
    assert.equal(open("readme.txt", 0, 1n << 1n) > 0, true, "a read-only open still works");
});

test("the directory listing resumes from its cookie and fills a short buffer", () => {
    const { api, wasm, open } = setup(sample());
    const fd = open(".");
    // "page" is a 28-byte entry; in a 30-byte buffer the next entry is cut short after 2 bytes.
    assert.equal(api.fd_readdir?.(fd, 5000, 30, 0n, 3300), 0);
    assert.equal(wasm.view.getUint32(3300, true), 30);
    assert.equal(wasm.view.getBigUint64(5000, true), 1n, "the cookie of the next entry");
    assert.equal(api.fd_readdir?.(fd, 5000, 1000, 1n, 3300), 0);
    assert.equal(wasm.view.getUint32(3300, true), 24 + "readme.txt".length);
    assert.equal(api.fd_readdir?.(fd, 5000, 1000, 2n, 3300), 0);
    assert.equal(wasm.view.getUint32(3300, true), 0, "the end of the listing");
});

// The calls that aren't about files, over a memory big enough for more than one 64 KiB chunk of random bytes.
const system = () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const wasm = new Wasm(memory, new WebAssembly.Table({ element: "anyfunc", initial: 1 }));
    const names = ["clock_time_get", "clock_res_get", "random_get", "proc_exit", "sock_accept"];
    const api = wasiImports(
        moduleWith(names),
        () => wasm,
        () => undefined,
    ).wasi_snapshot_preview1 as unknown as Record<string, Call>;
    return { api, wasm };
};

test("clocks: wall time and a monotonic clock in nanoseconds, at microsecond resolution", () => {
    const { api, wasm } = system();
    const before = BigInt(Date.now()) * 1_000_000n;
    assert.equal(api.clock_time_get?.(0, 0n, 8), 0);
    const realtime = wasm.view.getBigUint64(8, true);
    assert.ok(realtime >= before - 1_000_000n && realtime <= BigInt(Date.now() + 1) * 1_000_000n);
    assert.equal(api.clock_time_get?.(1, 0n, 16), 0);
    const first = wasm.view.getBigUint64(16, true);
    assert.equal(api.clock_time_get?.(1, 0n, 16), 0);
    assert.ok(wasm.view.getBigUint64(16, true) >= first, "monotonic");
    assert.equal(api.clock_res_get?.(0, 24), 0);
    assert.equal(wasm.view.getBigUint64(24, true), 1000n);
});

test("random bytes: more than 64 KiB in chunks, and without crypto from Math.random", () => {
    const { api, wasm } = system();
    const length = 65536 * 2 + 100;
    const filled = () => {
        wasm.bytes.fill(0, 0, length);
        assert.equal(api.random_get?.(0, length), 0);
        // Each 4 KiB stretch, the last chunk's included, has random bytes in it.
        for (let at = 0; at < length; at += 4096)
            assert.ok(
                wasm.bytes.subarray(at, Math.min(at + 4096, length)).some((b) => b !== 0),
                `bytes from ${at}`,
            );
    };
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    const calls: number[] = [];
    crypto.getRandomValues = ((array: Uint8Array<ArrayBuffer>) => {
        calls.push(array.length);
        return getRandomValues(array);
    }) as typeof crypto.getRandomValues;
    try {
        filled();
    } finally {
        crypto.getRandomValues = getRandomValues;
    }
    assert.deepEqual(calls, [65536, 65536, 100]);

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    assert.ok(descriptor?.configurable);
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
        filled();
    } finally {
        Object.defineProperty(globalThis, "crypto", descriptor);
    }
});

test("proc_exit throws; a WASI call this host lacks is NOSYS; an import from elsewhere is refused at load", () => {
    const { api } = system();
    assert.throws(() => api.proc_exit?.(3), /exited \(3\)/);
    assert.equal(api.sock_accept?.(0, 0, 0), 52);
    const wasm = () =>
        new Wasm(new WebAssembly.Memory({ initial: 1 }), new WebAssembly.Table({ element: "anyfunc", initial: 1 }));
    assert.throws(
        () => wasiImports(moduleWith(["fd_write", ["env", "emscripten_notify"]]), wasm, () => undefined),
        /imports env.emscripten_notify/,
    );
    const threads = wasiImports(moduleWith([["wasi", "thread-spawn"]]), wasm, () => undefined).wasi as Record<
        string,
        Call
    >;
    assert.equal(threads["thread-spawn"]?.(0), -1, "no threads without a spawner");
});
