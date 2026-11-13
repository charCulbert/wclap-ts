// An AudioWorklet module of your own: the mixer in mixer.ts, registered as "wclap-mixer". graph.ts loads it with
// createHost.
import { registerWclapProcessor } from "../src/worklet-api.ts";
import { Mixer } from "./mixer.ts";

export type { Levels, Routing } from "./mixer.ts";

registerWclapProcessor("wclap-mixer", (host) => new Mixer(host));
