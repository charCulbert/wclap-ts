// The WASI functions a WCLAP imports: text output, an empty environment, clocks and random bytes. With the bundle's
// files, the plug-in also reads them, read-only, under /plugin (preopened at fd 3). Every other call answers that it
// isn't supported.

import type { Log } from "./plugin-types.ts";
import { decodeUtf8, encodeUtf8 } from "./utf8.ts";
import type { Wasm } from "./wasm-struct.ts";

const SUCCESS = 0;
const ACCES = 2;
const BADF = 8;
const INVAL = 28;
const ISDIR = 31;
const NOENT = 44;
const NOSYS = 52;
const NOTDIR = 54;
const ROFS = 69;
const NOTCAPABLE = 76;

const FILETYPE_DIR = 3;
const FILETYPE_FILE = 4;
const OFLAG_CREAT = 1;
const OFLAG_DIRECTORY = 2;
const OFLAG_TRUNC = 8;
const PRESOPEN_FD = 3;
const PRESOPEN_NAME = "/plugin";

// Rights are bit numbers in the WASI spec; these are the ones this host reports or checks.
const right = (bit: number) => 1n << BigInt(bit);
const FD_READ = right(1);
const FD_SEEK = right(2);
const FD_TELL = right(5);
const FD_WRITE = right(6);
const PATH_OPEN = right(13);
const FD_READDIR = right(14);
const PATH_FILESTAT_GET = right(18);
const FD_FILESTAT_GET = right(21);
const FILE_RIGHTS = FD_READ | FD_SEEK | FD_TELL | FD_FILESTAT_GET;
const DIR_RIGHTS = PATH_OPEN | FD_READDIR | PATH_FILESTAT_GET | FD_FILESTAT_GET;

type Imports = Record<string, (...args: never[]) => unknown>;

// A file, or a directory (data null). Ino numbers are just unique within the bundle.
interface Node {
    readonly ino: number;
    readonly data: Uint8Array | null;
    readonly children: Map<string, Node>;
}

interface Open {
    readonly node: Node;
    offset: number;
}

// The bundle's files as a tree: a directory is implied by the paths under it. Paths with ".." are dropped.
function fileTree(files: Map<string, Uint8Array>): Node {
    let count = 0;
    const make = (data: Uint8Array | null): Node => ({ ino: ++count, data, children: new Map() });
    const root = make(null);
    for (const [path, data] of files) {
        const parts = path.split("/").filter((part) => part !== "" && part !== ".");
        const name = parts.pop();
        if (name === undefined || name === ".." || parts.includes("..")) continue;
        let dir = root;
        let blocked = false;
        for (const part of parts) {
            let next = dir.children.get(part);
            if (!next) {
                next = make(null);
                dir.children.set(part, next);
            }
            if (next.data) {
                blocked = true;
                break;
            }
            dir = next;
        }
        if (!blocked && !dir.children.has(name)) dir.children.set(name, make(data));
    }
    return root;
}

const filetype = (node: Node) => (node.data ? FILETYPE_FILE : FILETYPE_DIR);

export function wasiImports(
    module: WebAssembly.Module,
    wasm: () => Wasm,
    log: Log,
    files?: Map<string, Uint8Array>,
    // wasi-threads' thread-spawn: a new thread's ID, or a negative number when there won't be one.
    spawn?: (startArg: number) => number,
): WebAssembly.Imports {
    const u32 = (at: number, value: number) => wasm().view.setUint32(at, value, true);
    const none = (count: number, size: number) => {
        u32(count, 0);
        u32(size, 0);
        return SUCCESS;
    };
    const pending = ["", "", ""];
    const root = files && fileTree(files);
    const open = new Map<number, Open>();
    if (root) open.set(PRESOPEN_FD, { node: root, offset: 0 });

    // The node a path names, from a directory fd. Absolute paths and ".." are refused: nothing outside the bundle.
    const lookup = (dirFd: number, at: number, length: number): Node | number => {
        const dir = open.get(dirFd)?.node;
        if (!dir) return BADF;
        if (dir.data) return NOTDIR;
        const path = decodeUtf8(wasm().bytes.subarray(at, at + length));
        if (path.startsWith("/")) return NOTCAPABLE;
        let node = dir;
        for (const part of path.split("/")) {
            if (part === "" || part === ".") continue;
            if (part === "..") return NOTCAPABLE;
            if (node.data) return NOTDIR;
            const next = node.children.get(part);
            if (!next) return NOENT;
            node = next;
        }
        return node;
    };

    // A stat (64 bytes) for a node: the size of a file, zero for a directory.
    const writeStat = (node: Node, at: number) => {
        const bytes = wasm().bytes;
        bytes.fill(0, at, at + 64);
        const view = wasm().view;
        view.setBigUint64(at + 8, BigInt(node.ino), true);
        view.setUint8(at + 16, filetype(node));
        view.setBigUint64(at + 24, 1n, true);
        view.setBigUint64(at + 32, BigInt(node.data?.length ?? 0), true);
        return SUCCESS;
    };

    // Copies from a file at an offset into the plug-in's iovecs; returns the bytes copied.
    const readInto = (data: Uint8Array, offset: number, iovs: number, count: number) => {
        const view = wasm().view;
        const bytes = wasm().bytes;
        let total = 0;
        for (let i = 0; i < count && offset + total < data.length; i++) {
            const at = view.getUint32(iovs + i * 8, true);
            const length = view.getUint32(iovs + i * 8 + 4, true);
            const chunk = data.subarray(offset + total, offset + total + length);
            bytes.set(chunk, at);
            total += chunk.length;
        }
        return total;
    };

    const fns: Imports = {
        fd_write: (fd: number, iovs: number, count: number, written: number) => {
            if (fd !== 1 && fd !== 2) return BADF;
            const view = wasm().view;
            let total = 0;
            for (let i = 0; i < count; i++) {
                const at = view.getUint32(iovs + i * 8, true);
                const length = view.getUint32(iovs + i * 8 + 4, true);
                pending[fd] += decodeUtf8(wasm().bytes.subarray(at, at + length));
                total += length;
            }
            const lines = (pending[fd] ?? "").split("\n");
            pending[fd] = lines.pop() ?? "";
            for (const line of lines) log(line, fd === 2 ? "error" : "info");
            u32(written, total);
            return SUCCESS;
        },
        fd_prestat_get: (fd: number, at: number) => {
            if (fd !== PRESOPEN_FD || !root) return BADF;
            const view = wasm().view;
            view.setUint8(at, 0);
            view.setUint32(at + 4, PRESOPEN_NAME.length, true);
            return SUCCESS;
        },
        fd_prestat_dir_name: (fd: number, at: number, length: number) => {
            if (fd !== PRESOPEN_FD || !root) return BADF;
            if (length < PRESOPEN_NAME.length) return INVAL;
            wasm().bytes.set(encodeUtf8(PRESOPEN_NAME), at);
            return SUCCESS;
        },
        fd_fdstat_get: (fd: number, at: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            const view = wasm().view;
            wasm().bytes.fill(0, at, at + 24);
            view.setUint8(at, filetype(entry.node));
            view.setBigUint64(at + 8, entry.node.data ? FILE_RIGHTS : DIR_RIGHTS, true);
            return SUCCESS;
        },
        fd_filestat_get: (fd: number, at: number) => {
            const entry = open.get(fd);
            return entry ? writeStat(entry.node, at) : BADF;
        },
        path_filestat_get: (fd: number, _flags: number, at: number, length: number, out: number) => {
            const node = lookup(fd, at, length);
            return typeof node === "number" ? node : writeStat(node, out);
        },
        path_open: (
            fd: number,
            _dirflags: number,
            at: number,
            length: number,
            oflags: number,
            rights: bigint,
            _inheriting: bigint,
            _fdflags: number,
            out: number,
        ) => {
            if (oflags & (OFLAG_CREAT | OFLAG_TRUNC)) return ROFS;
            if (rights & FD_WRITE) return ACCES;
            const node = lookup(fd, at, length);
            if (typeof node === "number") return node;
            if (oflags & OFLAG_DIRECTORY && node.data) return NOTDIR;
            let opened = 4;
            while (open.has(opened)) opened++;
            open.set(opened, { node, offset: 0 });
            u32(out, opened);
            return SUCCESS;
        },
        fd_read: (fd: number, iovs: number, count: number, nread: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            if (!entry.node.data) return ISDIR;
            const read = readInto(entry.node.data, entry.offset, iovs, count);
            entry.offset += read;
            u32(nread, read);
            return SUCCESS;
        },
        fd_pread: (fd: number, iovs: number, count: number, offset: bigint, nread: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            if (!entry.node.data) return ISDIR;
            if (offset < 0n) return INVAL;
            u32(nread, readInto(entry.node.data, Number(offset), iovs, count));
            return SUCCESS;
        },
        fd_seek: (fd: number, offset: bigint, whence: number, out: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            if (!entry.node.data) return ISDIR;
            const base = [0, entry.offset, entry.node.data.length][whence];
            if (base === undefined) return INVAL;
            const next = base + Number(offset);
            if (next < 0) return INVAL;
            entry.offset = next;
            wasm().view.setBigUint64(out, BigInt(next), true);
            return SUCCESS;
        },
        fd_tell: (fd: number, out: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            wasm().view.setBigUint64(out, BigInt(entry.offset), true);
            return SUCCESS;
        },
        fd_readdir: (fd: number, buf: number, bufLength: number, cookie: bigint, used: number) => {
            const entry = open.get(fd);
            if (!entry) return BADF;
            if (entry.node.data) return NOTDIR;
            const bytes = wasm().bytes;
            const children = [...entry.node.children];
            let written = 0;
            for (let i = Number(cookie); i < children.length && written < bufLength; i++) {
                const [name, child] = children[i] ?? [];
                if (name === undefined || !child) break;
                const nameBytes = encodeUtf8(name);
                const record = new Uint8Array(24 + nameBytes.length);
                const header = new DataView(record.buffer);
                header.setBigUint64(0, BigInt(i + 1), true);
                header.setBigUint64(8, BigInt(child.ino), true);
                header.setUint32(16, nameBytes.length, true);
                header.setUint8(20, filetype(child));
                record.set(nameBytes, 24);
                const take = Math.min(record.length, bufLength - written);
                bytes.set(record.subarray(0, take), buf + written);
                written += take;
            }
            u32(used, written);
            return SUCCESS;
        },
        fd_close: (fd: number) => {
            // The preopen and stdout/stderr stay open.
            if (fd < 4 || !open.delete(fd)) return BADF;
            return SUCCESS;
        },
        // Writes to the bundle's files are refused.
        path_create_directory: () => ROFS,
        path_remove_directory: () => ROFS,
        path_unlink_file: () => ROFS,
        path_rename: () => ROFS,
        environ_sizes_get: none,
        environ_get: () => SUCCESS,
        args_sizes_get: none,
        args_get: () => SUCCESS,
        clock_res_get: (_id: number, out: number) => {
            wasm().view.setBigUint64(out, 1000n, true);
            return SUCCESS;
        },
        clock_time_get: (id: number, _precision: bigint, out: number) => {
            const ms = id === 0 ? Date.now() : (globalThis.performance?.now() ?? Date.now());
            wasm().view.setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
            return SUCCESS;
        },
        // An AudioWorklet may have no crypto; then the bytes are not cryptographically random.
        random_get: (at: number, length: number) => {
            const bytes = new Uint8Array(length);
            if (globalThis.crypto)
                for (let i = 0; i < length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
            else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
            wasm().bytes.set(bytes, at);
            return SUCCESS;
        },
        sched_yield: () => SUCCESS,
        proc_exit: (code: number) => {
            throw new Error(`the plug-in exited (${code})`);
        },
    };
    const preview1: Imports = {};
    const threads: Imports = {};
    for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
        if (kind !== "function") continue;
        if (from === "wasi_snapshot_preview1") preview1[name] = fns[name] ?? (() => NOSYS);
        else if (from === "wasi" && name === "thread-spawn") threads[name] = spawn ?? (() => -1);
        else throw new Error(`the plug-in imports ${from}.${name}, which this host doesn't provide`);
    }
    return { wasi_snapshot_preview1: preview1, wasi: threads };
}
