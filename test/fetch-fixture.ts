// Test bundles that aren't in the repo are fetched from their source, pinned by commit or release and checksum, and
// cached in .cache/. `npm run fixtures` fetches them all ahead of time; a test fetches any it needs that's missing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Fixture {
    name: string;
    url: string;
    sha256: string;
    licence: string;
    source: string;
}

const OPEN_WEBCLAP =
    "https://raw.githubusercontent.com/andremichelle/open-webclap/b5627e6bebbd1df35d6aa399e2acb31965cc6b50/site/public/bundled/";
const openWebclap = (name: string, sha256: string, licence: string, source: string): Fixture => ({
    name,
    url: `${OPEN_WEBCLAP}${name}.wclap.tar.gz`,
    sha256,
    licence,
    source,
});

// The bundles github.com/andremichelle/open-webclap builds, each under its plug-in's own licence.
export const OPEN_WEBCLAP_BUNDLES: Fixture[] = [
    openWebclap(
        "hive",
        "e0061f4cd42783d127856dec95f2aac50a742712c26f0a0623ba78a886451d62",
        "CC0-1.0",
        "https://github.com/andremichelle/open-webclap/tree/main/ports/hive",
    ),
    openWebclap(
        "note-lab",
        "ee44eeedfec0addca1903d4781a0b88a0e8ed84967591b8c3fe0d20f79782d50",
        "MIT",
        "https://github.com/andremichelle/open-webclap/tree/main/ports/note-lab",
    ),
    openWebclap(
        "pearls",
        "90b7022e48fe0d857ff8f3954bb24d8e22a8672c61f38afe3f565138915502cc",
        "MIT",
        "https://github.com/andremichelle/open-webclap/tree/main/ports/pearls",
    ),
    openWebclap(
        "oxo-synth2",
        "0fea61e2309b0fbb7b6b728fe5d711d88ade59e9248e109a3f888d3421b536cb",
        "MIT",
        "https://github.com/chab/oxo_synth2",
    ),
    openWebclap(
        "wet-chorus",
        "7630c2f047171d881041aab9750289c8839d7a526e59797cb35636f8856ae4a7",
        "MIT",
        "https://github.com/yonie/WetChorus",
    ),
    ...(
        [
            ["openrb-808", "d8b66ba2b37e9f652dfe94050ffed0456d4ae140dc318597e9c769f344fff179"],
            ["openrb-909", "ff219d5133855822b3652f2bacd3a47347ada3882f1701ca3b7f33fa23bb070d"],
            ["openrb-bass", "302844ad682cba55dacd99c3382600d771f19708d928d61d64a6ed4cc268198c"],
            ["openrb-compressor", "507bb01e0489d68ea3a4ce702784f0220340396069090091f49c3cb9e2caf310"],
            ["openrb-delay", "609e5347c92e19b0eb2f081c21279818d35c3ec4213545ceab976b5fa2356e5b"],
            ["openrb-distortion", "fbf1c5309b8c35a56a86bfd66d9fc47c625cd2fb58403c518532e5bb535168b0"],
            ["openrb-pcf", "1071d2c86d32c7f8b5c999fe6a9d5356c20807c1b9871582512ab77c283a44fa"],
        ] as const
    ).map(([name, sha256]) => openWebclap(name, sha256, "GPL-3.0-only", "https://github.com/pingw33n/openrb-338")),
];

// Our own test plug-ins, from a github.com/charCulbert/wclap-test-plugins release; each proves one thing a host must do.
const TEST_PLUGINS_RELEASE = "https://github.com/charCulbert/wclap-test-plugins/releases/download/v0.3.0/";
export const TEST_PLUGINS: Fixture[] = (
    [
        ["gui-lifecycle", "11c768226754c23c287a9fa68c4e5499dbcf3ce70457c50025e496c5de32f25c"],
        ["process-lifecycle", "8c3f83753f9c8e3db44eda2262424c2cbd5e584f9fc9b52f0d3787864ed029da"],
        ["probe", "62836df2f1462ee346ceeff86b573ee5e1b1c4621cf5987e6b17b6f16de26b38"],
        ["note-ids", "932001f41ec9fbc7cdb246a853f7cf21dc377a393437863c683b2cc486f06bc0"],
    ] as const
).map(([name, sha256]) => ({
    name,
    url: `${TEST_PLUGINS_RELEASE}${name}.wclap.tar.gz`,
    sha256,
    licence: "MIT",
    source: `https://github.com/charCulbert/wclap-test-plugins/tree/v0.3.0/plugins/${name}`,
}));

export const OUTSIDE_FIXTURES = [...TEST_PLUGINS, ...OPEN_WEBCLAP_BUNDLES];

// A note sequencer, used by the chain tests.
export const HIVE = OPEN_WEBCLAP_BUNDLES[0] as Fixture;

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
