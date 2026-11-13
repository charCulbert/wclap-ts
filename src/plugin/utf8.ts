// UTF-8 both ways. An AudioWorklet has neither TextEncoder nor TextDecoder.

export function decodeUtf8(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
        const b = bytes[i++] ?? 0;
        const extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
        let code = extra ? b & (0x3f >> extra) : b;
        for (let k = 0; k < extra; k++) code = (code << 6) | ((bytes[i++] ?? 0) & 0x3f);
        s += String.fromCodePoint(code);
    }
    return s;
}

export function encodeUtf8(s: string): Uint8Array {
    const out: number[] = [];
    for (const c of s) {
        const code = c.codePointAt(0) ?? 0;
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        else
            out.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
    }
    return new Uint8Array(out);
}
