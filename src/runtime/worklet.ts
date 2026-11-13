// worklet.js: the AudioWorklet module behind createChain, hosting plug-ins in a Chain. Bundled on its own.
import { Chain } from "../worklet/chain.ts";
import { registerWclapProcessor } from "../worklet/worklet-host.ts";

registerWclapProcessor("wclap-chain", (host) => Chain.fromHost(host));
