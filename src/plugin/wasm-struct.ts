// Typed access to CLAP structs in a WCLAP's memory, by the layouts in clap.generated.ts.
import { layouts } from "./clap.generated.ts";
import { decodeUtf8 } from "./utf8.ts";

export type Ptr<S extends string> = number & { readonly to: S };
export const NULL = 0 as Ptr<never>;
export const asPtr = <S extends string>(at: number): Ptr<S> => at as Ptr<S>;

type Scalar = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64" | "f32" | "f64" | "bool";
export type Word = Scalar | `ptr:${string}`;
type Field =
    | { readonly at: number; readonly type: Word }
    | { readonly at: number; readonly type: "fn"; readonly params: readonly Word[]; readonly result: Word | "void" }
    | { readonly at: number; readonly type: "struct"; readonly of: string }
    | { readonly at: number; readonly type: "chars"; readonly length: number }
    | { readonly at: number; readonly type: "array"; readonly of: Scalar; readonly length: number };
export interface Layout {
    readonly name: string;
    readonly size: number;
    readonly align: number;
    readonly fields: { readonly [name: string]: Field };
}

type Layouts = typeof layouts;
type Js<W> = W extends "u64" | "i64"
    ? bigint
    : W extends "bool"
      ? boolean
      : W extends `ptr:${infer S}`
        ? Ptr<S>
        : number;
type Fields<L extends Layout> = L["fields"];
type Where<L extends Layout, Shape> = {
    [K in keyof Fields<L>]: Fields<L>[K] extends Shape ? K : never;
}[keyof Fields<L>] &
    string;
type ValueOf<F> = F extends { type: "fn" } ? number : F extends { type: infer W } ? Js<W> : never;
// 64-bit fields also take a number (an integer within 2^53), written without allocating a BigInt.
type InputOf<F> = F extends { type: "u64" | "i64" } ? bigint | number : ValueOf<F>;
type Args<F> = F extends { params: infer P extends readonly Word[] } ? { -readonly [I in keyof P]: Js<P[I]> } : never;
type Result<F> = F extends { result: infer R } ? (R extends "void" ? undefined : Js<R>) : never;
type Inner<F> = F extends { of: infer N extends keyof Layouts } ? Struct<Layouts[N]> : never;
type Fn<F> = F extends { result: "void" } ? (...args: Args<F>) => void : (...args: Args<F>) => Result<F>;

const wasmType = (w: Word): number =>
    w === "u64" || w === "i64" ? 0x7e : w === "f32" ? 0x7d : w === "f64" ? 0x7c : 0x7f;
const unsigned = (w: Word): boolean => w === "u8" || w === "u16" || w === "u32" || w.startsWith("ptr:");

function fromWasm(w: Word | "void", v: unknown): unknown {
    if (w === "bool") return v !== 0;
    if (w === "u64") return BigInt.asUintN(64, v as bigint);
    if (w !== "void" && unsigned(w)) return (v as number) >>> 0;
    return v;
}
const toWasm = (w: Word | "void", v: unknown): unknown => (w === "bool" ? (v ? 1 : 0) : v);

// A wasm module that only re-exports a JS function, so the function can go in a table with this signature.
const wrappers = new Map<string, WebAssembly.Module>();
function wrapper(params: readonly Word[], result: Word | "void"): WebAssembly.Module {
    const p = params.map(wasmType);
    const r = result === "void" ? [] : [wasmType(result)];
    const key = `${p}:${r}`;
    let module = wrappers.get(key);
    if (!module) {
        const section = (id: number, body: number[]) => [id, body.length, ...body];
        module = new WebAssembly.Module(
            new Uint8Array([
                ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
                ...section(1, [1, 0x60, p.length, ...p, r.length, ...r]),
                ...section(2, [1, 1, 0x6d, 1, 0x66, 0x00, 0x00]),
                ...section(7, [1, 1, 0x66, 0x00, 0x00]),
            ]),
        );
        wrappers.set(key, module);
    }
    return module;
}

export class Wasm {
    readonly memory: WebAssembly.Memory;
    readonly table: WebAssembly.Table;
    #buffer: ArrayBufferLike | undefined;
    #view = new DataView(new ArrayBuffer(0));
    #bytes = new Uint8Array(0);

    constructor(memory: WebAssembly.Memory, table: WebAssembly.Table) {
        this.memory = memory;
        this.table = table;
    }

    // The memory's current buffer: a grow replaces it.
    get view(): DataView {
        const buffer = this.memory.buffer;
        if (buffer !== this.#buffer) {
            this.#buffer = buffer;
            this.#view = new DataView(buffer);
            this.#bytes = new Uint8Array(buffer);
        }
        return this.#view;
    }

    get bytes(): Uint8Array {
        return this.view && this.#bytes;
    }

    struct<L extends Layout>(layout: L, at: Ptr<L["name"]>): Struct<L> {
        return new Struct(this, layout, at);
    }

    string(at: Ptr<"char">, max = 1 << 20): string {
        const bytes = this.bytes;
        let end = at;
        while (end < at + max && bytes[end] !== 0) end++;
        return decodeUtf8(bytes.subarray(at, end));
    }

    read(w: Word, at: number): unknown {
        const v = this.view;
        switch (w) {
            case "u8":
                return v.getUint8(at);
            case "i8":
                return v.getInt8(at);
            case "u16":
                return v.getUint16(at, true);
            case "i16":
                return v.getInt16(at, true);
            case "i32":
                return v.getInt32(at, true);
            case "u64":
                return v.getBigUint64(at, true);
            case "i64":
                return v.getBigInt64(at, true);
            case "f32":
                return v.getFloat32(at, true);
            case "f64":
                return v.getFloat64(at, true);
            case "bool":
                return v.getUint8(at) !== 0;
            default:
                return v.getUint32(at, true);
        }
    }

    write(w: Word, at: number, value: unknown): void {
        const v = this.view;
        switch (w) {
            case "u8":
            case "i8":
                v.setUint8(at, value as number);
                break;
            case "u16":
            case "i16":
                v.setUint16(at, value as number, true);
                break;
            case "u64":
            case "i64":
                if (typeof value === "number") {
                    v.setUint32(at, value >>> 0, true);
                    v.setInt32(at + 4, Math.floor(value / 2 ** 32), true);
                } else v.setBigUint64(at, BigInt.asUintN(64, value as bigint), true);
                break;
            case "f32":
                v.setFloat32(at, value as number, true);
                break;
            case "f64":
                v.setFloat64(at, value as number, true);
                break;
            case "bool":
                v.setUint8(at, value ? 1 : 0);
                break;
            default:
                v.setUint32(at, value as number, true);
        }
    }

    // Puts a JS function in the table, converting its arguments and result like `call`; returns its index.
    addFn(params: readonly Word[], result: Word | "void", fn: (...args: never[]) => unknown): number {
        const js = (...raw: unknown[]) => {
            for (let i = 0; i < raw.length; i++) raw[i] = fromWasm(params[i] ?? "i32", raw[i]);
            return toWasm(result, fn(...(raw as never[])));
        };
        const exported = new WebAssembly.Instance(wrapper(params, result), { m: { f: js } }).exports.f;
        return this.table.grow(1, exported);
    }
}

export class Struct<L extends Layout> {
    readonly wasm: Wasm;
    readonly layout: L;
    #at: Ptr<L["name"]>;

    constructor(wasm: Wasm, layout: L, at: Ptr<L["name"]>) {
        this.wasm = wasm;
        this.layout = layout;
        this.#at = at;
    }

    get at(): Ptr<L["name"]> {
        return this.#at;
    }

    // The same view at another address, so the audio path can reuse one view instead of making new ones.
    moveTo(at: Ptr<L["name"]>): this {
        this.#at = at;
        return this;
    }

    #field(name: string): Field {
        const f = this.layout.fields[name];
        if (!f) throw new Error(`${this.layout.name} has no field ${name}`);
        return f;
    }

    #word(name: string): { at: number; type: Word } {
        const f = this.#field(name);
        if (f.type === "fn") return { at: f.at, type: "u32" };
        if (f.type === "struct" || f.type === "chars" || f.type === "array")
            throw new Error(`${this.layout.name}.${name} is not a single value`);
        return f;
    }

    get<K extends Where<L, { type: Word | "fn" }>>(field: K): ValueOf<Fields<L>[K]> {
        const f = this.#word(field);
        return this.wasm.read(f.type, this.at + f.at) as never;
    }

    set<K extends Where<L, { type: Word }>>(field: K, value: InputOf<Fields<L>[K]>): void {
        const f = this.#word(field);
        this.wasm.write(f.type, this.at + f.at, value);
    }

    string<K extends Where<L, { type: "chars" | "ptr:char" }>>(field: K): string {
        const f = this.#field(field);
        if (f.type === "chars") return this.wasm.string(asPtr(this.at + f.at), f.length);
        const at = this.wasm.read("u32", this.at + f.at) as number;
        return at ? this.wasm.string(asPtr(at)) : "";
    }

    inner<K extends Where<L, { type: "struct" }>>(field: K): Inner<Fields<L>[K]> {
        const f = this.#field(field);
        if (f.type !== "struct") throw new Error(`${this.layout.name}.${field} is not a struct`);
        const layout: Layout | undefined = (layouts as Record<string, Layout>)[f.of];
        if (!layout) throw new Error(`no layout for ${f.of}`);
        return new Struct(this.wasm, layout, asPtr(this.at + f.at)) as never;
    }

    #item(field: string, index: number): { at: number; type: Scalar } {
        const f = this.#field(field);
        if (f.type !== "array") throw new Error(`${this.layout.name}.${field} is not an array`);
        if (!(index >= 0 && index < f.length))
            throw new Error(`${this.layout.name}.${field}[${index}] is out of range`);
        const size = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 }[f.of];
        return { at: this.at + f.at + index * size, type: f.of };
    }

    item<K extends Where<L, { type: "array" }>>(field: K, index: number): number {
        const f = this.#item(field, index);
        return this.wasm.read(f.type, f.at) as number;
    }

    setItem<K extends Where<L, { type: "array" }>>(field: K, index: number, value: number): void {
        const f = this.#item(field, index);
        this.wasm.write(f.type, f.at, value);
    }

    #fn(field: string): Extract<Field, { type: "fn" }> {
        const f = this.#field(field);
        if (f.type !== "fn") throw new Error(`${this.layout.name}.${field} is not a function`);
        return f;
    }

    has<K extends Where<L, { type: "fn" }>>(field: K): boolean {
        return this.wasm.read("u32", this.at + this.#fn(field).at) !== 0;
    }

    call<K extends Where<L, { type: "fn" }>>(field: K, ...args: Args<Fields<L>[K]>): Result<Fields<L>[K]> {
        const f = this.#fn(field);
        const index = this.wasm.read("u32", this.at + f.at) as number;
        if (index === 0) throw new Error(`${this.layout.name}.${field} is null`);
        const fn = this.wasm.table.get(index) as (...raw: unknown[]) => unknown;
        const raw = args as unknown[];
        for (let i = 0; i < raw.length; i++) raw[i] = toWasm(f.params[i] ?? "i32", raw[i]);
        return fromWasm(f.result, fn(...raw)) as never;
    }

    setFn<K extends Where<L, { type: "fn" }>>(field: K, fn: Fn<Fields<L>[K]>): void {
        const f = this.#fn(field);
        this.wasm.write(
            "u32",
            this.at + f.at,
            this.wasm.addFn(f.params, f.result, fn as (...args: never[]) => unknown),
        );
    }

    // A function already in the table, by its index.
    setIndex<K extends Where<L, { type: "fn" }>>(field: K, index: number): void {
        this.wasm.write("u32", this.at + this.#fn(field).at, index);
    }
}
