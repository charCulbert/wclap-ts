// Writes src/plugin/clap.generated.ts: every CLAP struct's layout for wasm32, and the CLAP constants, as clang sees them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const include = new URL("../external/clap/include", import.meta.url).pathname;
const out = new URL("../src/plugin/clap.generated.ts", import.meta.url).pathname;

// WASI_SDK_PATH, or wasi-sdk 33 fetched once into .cache/. Any version gives the same layouts.
const sdkVersion = "33.0";
const sdkSha256: Record<string, string> = {
    "arm64-macos": "85c997a2665ead91673b5bb88b7d0df3fc8900df3bfa244f720d478187bbdc78",
    "x86_64-macos": "18f3f201ba9734e6a4455b0b6410690395a55e9ffa9f6f5066f66083a94b93b3",
    "arm64-linux": "4f98ee738c7abb45c81a94d1461fc53cc569d1cd01498951c8184d841a027844",
    "x86_64-linux": "0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce",
};

async function wasiSdk(): Promise<string> {
    if (process.env.WASI_SDK_PATH) return process.env.WASI_SDK_PATH;
    const arch = { arm64: "arm64", x64: "x86_64" }[process.arch as string];
    const os = { darwin: "macos", linux: "linux" }[process.platform as string];
    const host = `${arch}-${os}`;
    const sha256 = sdkSha256[host];
    if (!arch || !os || !sha256) throw new Error(`no wasi-sdk download for ${host}: set WASI_SDK_PATH`);
    const dir = new URL(`../.cache/wasi-sdk-${sdkVersion}-${host}`, import.meta.url).pathname;
    if (existsSync(`${dir}/bin/clang`)) return dir;
    const name = `wasi-sdk-${sdkVersion}-${host}.tar.gz`;
    const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${sdkVersion.split(".")[0]}/${name}`;
    console.log(`fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const tarball = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(tarball).digest("hex") !== sha256) throw new Error(`${name}: wrong checksum`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", "-", "-C", dir, "--strip-components=1"], { input: tarball, maxBuffer: 1 << 30 });
    return dir;
}
const sdk = await wasiSdk();

const clang = (source: string, ...flags: string[]): string =>
    execFileSync(`${sdk}/bin/clang`, ["--target=wasm32-wasip1-threads", `-I${include}`, "-x", "c", ...flags, "-"], {
        input: `#include <clap/clap.h>\n#include <clap/ext/draft/webview.h>\n#include <stddef.h>\n${source}`,
        maxBuffer: 1 << 30,
        encoding: "utf8",
    });

// One declaration in clang's syntax tree (a struct, field, typedef, enum constant…); only what is read here.
interface Decl {
    kind: string;
    name?: string;
    tagUsed?: string;
    completeDefinition?: boolean;
    type?: { qualType: string };
    value?: string;
    inner?: Decl[];
}

const ast: Decl[] = JSON.parse(clang("", "-fsyntax-only", "-Xclang", "-ast-dump=json")).inner;

const typedefs = new Map<string, string>();
for (const d of ast) if (d.kind === "TypedefDecl" && d.name && d.type) typedefs.set(d.name, d.type.qualType);

const scalars: Record<string, string> = {
    _Bool: "bool",
    char: "i8",
    "signed char": "i8",
    "unsigned char": "u8",
    short: "i16",
    "unsigned short": "u16",
    int: "i32",
    "unsigned int": "u32",
    long: "i32",
    "unsigned long": "u32",
    "long long": "i64",
    "unsigned long long": "u64",
    float: "f32",
    double: "f64",
};

type Type =
    | { type: string }
    | { type: "fn"; params: string[]; result: string }
    | { type: "struct"; of: string }
    | { type: "chars"; length: number }
    | { type: "array"; of: string; length: number };

function splitParams(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) {
            parts.push(list.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(list.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p !== "void" && p !== "");
}

// A C type as one word: "u32", "f64", "bool", "ptr:clap_host", "ptr:ptr:f32", "ptr:void", or a struct's name.
function word(c: string): string {
    const t = resolve(c);
    if ("of" in t && t.type === "struct") return t.of;
    if (t.type === "fn" || "length" in t) throw new Error(`not a value type: ${c}`);
    return t.type;
}

function resolve(c: string): Type {
    const t = c.replace(/\b(const|volatile)\b/g, "").trim();
    const fn = t.match(/^(.*?)\s*\(\*\)\s*\((.*)\)$/s);
    if (fn?.[1] !== undefined && fn[2] !== undefined) {
        const result = fn[1].trim() === "void" ? "void" : word(fn[1]);
        return { type: "fn", params: splitParams(fn[2]).map(word), result };
    }
    const array = t.match(/^(.*)\[(\d+)\]$/);
    if (array?.[1] !== undefined && array[2] !== undefined) {
        const of = word(array[1]);
        const length = Number(array[2]);
        return of === "i8" ? { type: "chars", length } : { type: "array", of, length };
    }
    if (t.endsWith("*")) {
        const to = t.slice(0, -1).trim();
        if (to === "void" || to === "char") return { type: `ptr:${to}` };
        if (/\(\*\)/.test(to)) return { type: "ptr:fn" };
        return { type: `ptr:${word(to)}` };
    }
    const struct = t.match(/^(?:struct|union) (\w+)$/);
    if (struct?.[1]) return { type: "struct", of: struct[1] };
    const scalar = scalars[t];
    if (scalar) return { type: scalar };
    const alias = typedefs.get(t);
    if (alias !== undefined) return resolve(alias);
    throw new Error(`unknown C type: ${c}`);
}

// Every number comes from clang compiling `long long vN = <C expression>;` and reading vN back.
const expressions: string[] = [];
const ask = (expression: string): number => expressions.push(expression) - 1;

// A record's fields; an anonymous union's members are fields of the record itself, as in C.
function fieldsOf(record: Decl): { name: string; type: string }[] {
    const decls = record.inner ?? [];
    return decls.flatMap((d, i) => {
        if (d.kind !== "FieldDecl" || !d.type) return [];
        if (d.name) return [{ name: d.name, type: d.type.qualType }];
        return fieldsOf(decls[i - 1] ?? { kind: "" });
    });
}

const structs = ast
    .filter((d) => d.kind === "RecordDecl" && d.completeDefinition && d.name?.startsWith("clap_"))
    .map((d) => {
        const tag = `${d.tagUsed} ${d.name}`;
        const fields = fieldsOf(d).map((f) => ({ ...f, at: ask(`offsetof(${tag}, ${f.name})`) }));
        return { name: d.name ?? "", size: ask(`sizeof(${tag})`), align: ask(`_Alignof(${tag})`), fields };
    });

const numbers: { name: string; wide: boolean; value: number }[] = [];
const strings: string[] = [];
const stringIn = (n: Decl): string | undefined =>
    n.kind === "StringLiteral" ? n.value : n.inner?.map(stringIn).find((s) => s !== undefined);
for (const d of ast) {
    if (d.kind === "EnumDecl")
        for (const e of d.inner ?? [])
            if (e.kind === "EnumConstantDecl" && e.name?.startsWith("CLAP_"))
                numbers.push({ name: e.name, wide: false, value: ask(e.name) });
    if (d.kind !== "VarDecl" || !d.name?.startsWith("CLAP_") || !d.type) continue;
    const t = resolve(d.type.qualType);
    if (t.type === "chars") {
        const s = stringIn(d);
        if (s !== undefined) strings.push(`export const ${d.name} = ${s};`);
    } else if (!("of" in t))
        numbers.push({ name: d.name, wide: t.type === "u64" || t.type === "i64", value: ask(d.name) });
}
for (const m of clang("", "-dM", "-E").matchAll(/^#define (CLAP_\w+) ("[^"]*"|\d+)$/gm))
    strings.push(`export const ${m[1]} = ${m[2]};`);

const ir = clang(expressions.map((e, i) => `long long v${i} = ${e};`).join("\n"), "-S", "-emit-llvm", "-o", "-");
const values = new Map<number, string>();
for (const m of ir.matchAll(/^@v(\d+) = .* i64 (-?\d+),/gm)) values.set(Number(m[1]), m[2] ?? "");
const value = (i: number): string => {
    const v = values.get(i);
    if (v === undefined) throw new Error(`clang gave no value for ${expressions[i]}`);
    return v;
};

const lines = [
    "// Generated by tools/gen-clap.ts from external/clap, for wasm32. Don't edit; run `npm run gen`.",
    "// CLAP's layouts and constants are from the CLAP SDK (MIT, Copyright (c) 2021 Alexandre BIQUE).",
    ...structs.map((s) => {
        const fields = s.fields.map(
            (f) => `${f.name}: ${JSON.stringify({ at: Number(value(f.at)), ...resolve(f.type) })}`,
        );
        return (
            `export const ${s.name} = { name: "${s.name}", size: ${value(s.size)}, align: ${value(s.align)}, ` +
            `fields: { ${fields.join(", ")} } } as const;`
        );
    }),
    `export const layouts = { ${structs.map((s) => s.name).join(", ")} } as const;`,
    ...strings,
    ...numbers.map((n) => `export const ${n.name} = ${value(n.value)}${n.wide ? "n" : ""};`),
    "",
];
writeFileSync(out, lines.join("\n"));
