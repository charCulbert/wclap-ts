// What every example page shares: a start button (browsers need a tap before sound), a status line, and its own
// source code shown on the page.
export const base = "/dist/";
// Hive, a note sequencer (CC0-1.0) from github.com/andremichelle/open-webclap, pinned to a commit.
export const HIVE =
    "https://raw.githubusercontent.com/andremichelle/open-webclap/b430912ae8fa21b42b10ab6d0bf22c6c541c7c36/site/public/bundled/hive.wclap.tar.gz";

export function status(text: string): void {
    const line = document.querySelector("#status");
    if (line) line.textContent = text;
}

// Resolves with a running AudioContext once the visitor taps Start.
export function started(): Promise<AudioContext> {
    const button = document.querySelector<HTMLButtonElement>("#start");
    return new Promise((resolve) => {
        if (!button) return;
        button.onclick = async () => {
            button.disabled = true;
            const context = new AudioContext({ latencyHint: "interactive" });
            await context.resume();
            button.hidden = true;
            resolve(context);
        };
    });
}

// Shows this page's script, as written, under the page.
export async function showSource(name: string): Promise<void> {
    const code = document.querySelector("#source");
    if (!code) return;
    code.textContent = await (await fetch(`/examples/${name}.ts`)).text();
}
