// Opens a WCLAP: a .wclap.tar.gz bundle (module.wasm and its files) or a bare .wasm.

export interface Bundle {
    module: WebAssembly.Module;
    // The memory the module imports, if it imports one; otherwise it brings its own.
    memory: { initial: number; maximum: number; shared: boolean } | null;
    files: Map<string, Uint8Array>;
}

export interface BundleLimits {
    // The most a bundle may unpack to, in bytes; 256 MB by default.
    maxUnpackedBytes?: number;
    // The most any file but module.wasm (the interface's resources) may hold, in bytes; 32 MB by default.
    maxFileBytes?: number;
    // The most memory a module may start with, in MB; 1024 by default.
    maxMemoryMB?: number;
}

export async function openBundle(bytes: Uint8Array, limits: BundleLimits = {}): Promise<Bundle> {
    const { maxUnpackedBytes = 256 << 20, maxFileBytes = 32 << 20, maxMemoryMB = 1024 } = limits;
    const isWasm = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
    const files = isWasm
        ? new Map([["module.wasm", bytes]])
        : untar(await gunzip(bytes, maxUnpackedBytes), maxFileBytes);
    const wasm = files.get("module.wasm");
    if (!wasm) throw new Error("the bundle has no module.wasm");
    files.delete("module.wasm");
    const memory = importedMemory(wasm);
    const initial = memory?.initial ?? ownInitialMemory(wasm);
    if (initial * 65536 > maxMemoryMB * 1024 * 1024)
        throw new Error(`the module starts with ${initial} memory pages, more than maxMemoryMB (${maxMemoryMB} MB)`);
    return { module: await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>), memory, files };
}

// Stops inflating as soon as the output passes `max`.
async function gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array> {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > max) throw new Error(`the bundle unpacks to more than maxUnpackedBytes (${max} bytes)`);
        chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

// Regular files by path, relative to the folder holding module.wasm.
function untar(tar: Uint8Array, maxFileBytes: number): Map<string, Uint8Array> {
    const text = (at: number, length: number) =>
        new TextDecoder().decode(tar.subarray(at, at + length)).replace(/\0.*$/s, "");
    const entries = new Map<string, Uint8Array>();
    let longName: string | undefined;
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const size = parseInt(text(at + 124, 12).trim() || "0", 8);
        const type = String.fromCharCode(tar[at + 156] ?? 0);
        const prefix = text(at + 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${text(at, 100)}` : text(at, 100));
        const data = tar.subarray(at + 512, at + 512 + size);
        longName = undefined;
        if (type === "x") longName = new TextDecoder().decode(data).match(/^\d+ path=(.*)$/m)?.[1];
        else if ((type === "0" || type === "\0") && !/(^|\/)\._/.test(name)) {
            if (name.startsWith("/") || name.split("/").includes(".."))
                throw new Error(`unsafe path in bundle: ${name}`);
            if (size > maxFileBytes && !name.endsWith("module.wasm"))
                throw new Error(`${name} is larger than maxFileBytes (${maxFileBytes} bytes)`);
            entries.set(name.replace(/^\.\//, ""), data);
        }
        at += 512 + Math.ceil(size / 512) * 512;
    }
    const wasm = [...entries.keys()].filter((n) => n.endsWith("module.wasm")).sort((a, b) => a.length - b.length)[0];
    const root = wasm?.slice(0, -"module.wasm".length) ?? "";
    const files = new Map<string, Uint8Array>();
    for (const [name, data] of entries) if (name.startsWith(root)) files.set(name.slice(root.length), data);
    return files;
}

// The limits of an imported memory, read from the import section (the JS API doesn't report them).
function importedMemory(wasm: Uint8Array): Bundle["memory"] {
    const reader = new ModuleReader(wasm);
    while (!reader.done) {
        const section = reader.byte();
        const length = reader.varuint();
        if (section !== IMPORT_SECTION) {
            reader.skip(length);
            continue;
        }
        for (let imports = reader.varuint(); imports > 0; imports--) {
            reader.skip(reader.varuint()); // module name
            reader.skip(reader.varuint()); // field name
            const kind = reader.byte();
            if (kind === IMPORT_MEMORY) return reader.limits();
            reader.skipImport(kind);
        }
        return null;
    }
    return null;
}

// The first declared memory's initial size in pages, 0 if none.
function ownInitialMemory(wasm: Uint8Array): number {
    const reader = new ModuleReader(wasm);
    while (!reader.done) {
        const section = reader.byte();
        const length = reader.varuint();
        if (section === MEMORY_SECTION) return reader.varuint() > 0 ? reader.limits().initial : 0;
        reader.skip(length);
    }
    return 0;
}

const IMPORT_SECTION = 2;
const MEMORY_SECTION = 5;
const [IMPORT_FUNCTION, IMPORT_TABLE, IMPORT_MEMORY, IMPORT_GLOBAL] = [0, 1, 2, 3];

// Reads a module's binary format from just after its 8-byte header.
class ModuleReader {
    #at = 8;
    readonly bytes: Uint8Array;
    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }

    get done(): boolean {
        return this.#at >= this.bytes.length;
    }
    byte(): number {
        return this.bytes[this.#at++] ?? 0;
    }
    skip(count: number): void {
        this.#at += count;
    }
    // Unsigned LEB128, kept in a double: a memory maximum can need all 32 bits.
    varuint(): number {
        let result = 0;
        for (let scale = 1; ; scale *= 128) {
            const b = this.byte();
            result += (b & 0x7f) * scale;
            if (b < 0x80 || this.done) return result;
        }
    }
    // Memory limits: bit 0 of the flags says a maximum follows, bit 1 that the memory is shared.
    limits(): NonNullable<Bundle["memory"]> {
        const flags = this.varuint();
        const initial = this.varuint();
        const maximum = flags & 1 ? this.varuint() : 65536;
        return { initial, maximum, shared: (flags & 2) !== 0 };
    }
    skipImport(kind: number): void {
        if (kind === IMPORT_FUNCTION) this.varuint();
        else if (kind === IMPORT_TABLE) {
            this.byte();
            this.limits();
        } else if (kind === IMPORT_GLOBAL) this.skip(2);
        else {
            this.byte(); // a tag: its attribute, then its type index
            this.varuint();
        }
    }
}
