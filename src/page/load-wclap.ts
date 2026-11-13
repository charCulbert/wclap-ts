import type { Source } from "./message-link.ts";
import { type AddOptions, type ChainOptions, WclapHost } from "./wclap-host.ts";
import type { WclapPlugin } from "./wclap-plugin.ts";

// One plug-in, as a chain of one.
export async function loadWclap(
    context: BaseAudioContext,
    source: Source,
    // `ui`: where to show its interface, as from querySelector.
    options: ChainOptions & AddOptions & { ui?: Element | null | undefined } = {},
): Promise<WclapPlugin> {
    const ui = options.ui;
    if (ui === null) throw new Error("ui is null: no element matched the selector");
    if (ui !== undefined && !(ui instanceof HTMLElement)) throw new Error("ui must be an HTML element");
    const chain = await WclapHost.create(context, options);
    const plugin = await chain.add(source, options);
    plugin.own();
    if (ui) await plugin.showInterface(ui);
    return plugin;
}
