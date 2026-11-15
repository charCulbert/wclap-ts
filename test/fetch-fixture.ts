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
const TEST_PLUGINS_RELEASE = "https://github.com/charCulbert/wclap-test-plugins/releases/download/v0.3.3/";
export const TEST_PLUGINS: Fixture[] = (
    [
        ["audio-ports-activation", "1026e83183e723981cb01ef9ffaa3dce2acbe53eaed07fbd5d73ed9851e27391"],
        ["crash", "1b382a4b8f0904ac85760621955304cee006e0dd17271039df91d23ee8e95272"],
        ["gui-lifecycle", "4f54276e00190d5a6c166fca40c0bb0ebe065b0fbda64271411d90c24aa6ba1a"],
        ["log", "da277e4a1a8cb4c8ce7487da223821179264baaf50eb017307f6f21926ec5371"],
        ["midi-echo", "a026a3a22ea4b7dd3f090b7c234845ff2cbc13df8b3aa4a1d2fa21de6bd29df5"],
        ["note-ids", "150fb86fafe3bced42e9902b23cefd4de75f8e90581aec5fa78e6eb334d173ce"],
        ["note-name", "4980da1775737824f323c6df77cd47f6bb5bcf029b56a8cb2530dcc58fa0197f"],
        ["param-indication", "b6d1a06b86fa5c02f775cb5557309f87094516d6ac693df6e6f10ba2b21ae6bb"],
        ["probe", "9b9f152b66efca50a663b46c485d81bd5cacbce39fe85f5e248babc437b0ecb9"],
        ["process-lifecycle", "17efb111bb546f8155d101b3863e30c4c090b6a0cd7558c52c0d034c98132871"],
        ["remote-controls", "ce25e566d7a2ec12d36f847a6977e226267049fd350569dc5372113319bf6050"],
        ["render", "6b2bbd2cb27631509a7a704adb1941b5d22aa565c839d5b5d53ef96527e03299"],
        ["state-context", "451b8cd970635048c65a49fae72448bf1e523ef16caf758366e413caabfad483"],
        ["transport", "720cd34022c1bac6d23347c40247be57f8f0207cfd312a6704320b1272b73668"],
        ["voice-info", "c908928af6358126b541db05cb6fede9eb80b2b0c9ae3783a9d8c72f4b47fbca"],
    ] as const
).map(([name, sha256]) => ({
    name,
    url: `${TEST_PLUGINS_RELEASE}${name}.wclap.tar.gz`,
    sha256,
    licence: "MIT",
    source: `https://github.com/charCulbert/wclap-test-plugins/tree/v0.3.3/plugins/${name}`,
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
