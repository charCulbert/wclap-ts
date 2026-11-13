# wclap-ts

> **In development.** The API will change.

WCLAP audio plug-ins on a web page: one plug-in, a chain of them, or several side by side. No runtime
dependencies.

A WCLAP is a [CLAP](https://cleveraudio.org) plug-in compiled to WebAssembly. wclap-ts loads one into an
AudioWorklet, runs its main-thread work on a Worker when the plug-in allows it, shows its own interface, and plays
notes and parameter changes on the frame you ask for.

## Quick start

```sh
npm install github:charCulbert/wclap-ts   # builds itself on install
```

The type declarations need TypeScript 5.7 or later.

Serve your pages with these two headers, which shared memory needs:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Then, after a click (browsers start audio only after one):

```ts
import { loadWclap } from "wclap-ts";

const context = new AudioContext();
const synth = await loadWclap(context, "/plugins/MySynth.wclap.tar.gz", {
    ui: document.querySelector("#synth"),
});
synth.connect(context.destination);
synth.noteOn(60, 0.8);
synth.noteOff(60, 0, context.currentTime + 0.5);
```

`ui` shows the plug-in's own interface in that element, or a panel of its parameters if it has none.

wclap-ts starts its AudioWorklet and Workers from files beside its own (`dist/`), found from where it was loaded,
so a page that imports it from `node_modules` needs nothing else. If your bundler moves the library and leaves those
files behind, or you serve them from elsewhere, copy them to a folder your site serves and name it:

```sh
npx wclap-ts setup public/wclap
```

```ts
const synth = await loadWclap(context, url, { base: "/wclap/" });
```

### Without the headers

Where you can't set headers (GitHub Pages, for one), a service worker adds them. It must sit beside your pages (a
service worker only reaches pages in its own folder and below), so copy it there and call `isolate()` before
anything else; the page reloads once:

```sh
npx wclap-ts setup --sw public
```

```ts
import { isolate } from "wclap-ts";
await isolate(); // registers wclap-sw.js beside the page
```

## A chain

```ts
import { createChain } from "wclap-ts";

const chain = await createChain(context);
const arp = await chain.add("/plugins/Arp.wclap.tar.gz");
const synth = await chain.add("/plugins/Synth.wclap.tar.gz");
const delay = await chain.add("/plugins/Delay.wclap.tar.gz");
chain.connect(context.destination);

chain.noteOn(60, 0.8); // to the first plug-in; the arpeggiator's notes go on to the synth
synth.param(3, 0.25); // to one plug-in
delay.enabled = false; // bypass
chain.move(delay, 0); // reorder while it plays
await chain.remove(arp);
await chain.connectMidi(); // every MIDI input plays the chain
```

All plug-ins in a chain run in one AudioWorkletNode, in order, within each block. Audio goes from each plug-in to
the next. Notes a plug-in sends out go to the next plug-in in the same block, and the last plug-in's notes come out
of the chain (`chain.connectMidiOut(output)`).

A plug-in that crashes (in WebAssembly, a trap) goes silent and is marked `failed`; the rest play on.

## Several chains: A/B, tracks and sends

Chains are Web Audio nodes, so ordinary nodes connect them. Every chain on a context schedules on the same clock:
two notes given the same `when` land on the same frame.

```ts
import { alignLatency, createChain } from "wclap-ts";

const drums = await createChain(context, { base });
const synth = await createChain(context, { base });
const reverb = await createChain(context, { base });
// ...add plug-ins...

const outputs = await alignLatency([drums, synth]); // delays the faster chain to match the slower
for (const out of outputs.values()) {
    out.connect(context.destination);
    out.connect(new GainNode(context, { gain: 0.3 })).connect(reverb.input);
}
reverb.connect(context.destination);
```

`alignLatency` follows latency changes the plug-ins report. `examples/mix.ts` is a full version, and
`examples/ab.ts` switches between two plug-ins fed the same notes.

## What a plug-in offers

| What             | Calls                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Notes            | `noteOn`, `noteOff`, with an optional AudioContext time and channel                                                                   |
| Parameters       | `params`, `param(id, value, when?)`, `values`                                                                                         |
| Modulation       | `modulate(id, amount, when?, note?)`, for every voice or one note                                                                     |
| Note expressions | `expression(kind, key, value, when?)`: tuning, pressure, and the rest of CLAP's list                                                  |
| State            | `saveState()`, `loadState(bytes)`, `presets()`, `loadPreset(preset)`                                                                  |
| Interface        | `showInterface(element)`, `hideInterface()`                                                                                           |
| Information      | `latency()`, `tail()`, `valueText(id, value)`, `remoteControls()`, `noteNames()`                                                      |
| MIDI             | `connectMidi()` on a plug-in from `loadWclap`; on a chain, `connectMidi()`, `connectMidiOut(output)` and `mapCC(cc, plugin, paramId)` |

Calls that ask the plug-in something return promises, since the plug-in may be running on another thread.

Both plug-ins and chains are `EventTarget`s:

| Event           | On      | `detail`                                                                                                                                                                           |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `param`         | plug-in | `{ id, value }`: the plug-in moved a parameter itself (its interface, or automation inside it)                                                                                     |
| `gesture`       | plug-in | `{ id, begin }`: its interface started or finished a drag, one undo step                                                                                                           |
| `change`        | plug-in | `{ what }`: `"latency"`, `"params"` (reloaded into `params`), `"note-names"`, `"state"` (unsaved changes), or `"ports"` (the plug-in changed its ports; load it again to use them) |
| `noteout`       | chain   | `{ on, key, velocity, channel, time }`: a note leaving the last plug-in                                                                                                            |
| `latencychange` | chain   | none: a plug-in reported a new latency, or one was added, removed or bypassed                                                                                                      |

```ts
synth.addEventListener("param", (e) => console.log(e.detail.id, e.detail.value));
```

A bypassed plug-in still takes parameter changes, fades out over one block (unless it's stopping just then, for a
restart or removal), and lets go of its notes; brought back, it's reset and fades in. Notes sent to a bypassed
plug-in pass on to the next one, as if it weren't there. Moving, removing or bypassing a plug-in also lets go of the
notes held by the plug-ins after it, since their note-offs would no longer reach them.

## Timing, transport and health

- `noteOn`, `param` and the rest take an AudioContext time and land on that frame. Without one, the event plays as
  soon as it safely can: the `lead` option (256 frames by default, about 5 ms at 48 kHz) after the call, so live
  playing keeps its spacing.
- They return `false` if the event queue is full and the event was dropped. A note-off is never dropped: it waits
  for room, so a note can't hang.
- Host-synced plug-ins (arpeggiators, synced delays) follow a transport: `chain.transport.tempo`, `.playing`,
  `.setTimeSignature(n, d)`, `.seek(beats)`, and `.beats` for the position now. Each host has its own unless you
  share one, which keeps them in step to the frame:

  ```ts
  const transport = createTransport(context, { tempo: 128 });
  const drums = await createChain(context, { transport });
  const bass = await createChain(context, { transport });
  transport.tempo = 132; // both, on the same block
  ```
- A host only runs while its node is connected, directly or through other nodes, to the context's destination. A
  chain that makes no sound (a sequencer whose notes you take from `noteout`) still needs a path there: connect it
  through a `GainNode` at 0.
- A plug-in that crashes stays in `chain.plugins` with `failed` set, silent, and adds no latency; remove it to tidy
  up.
- `onStats` (a chain option) reports, about once a second when anything changed: events that arrived too late for
  their frame, events dropped, audio stalls over 20 ms, the longest gap between blocks and the longest block.
- `chain.remove(plugin)` waits for the plug-in to stop on the audio thread before destroying it, up to 2 s if the
  AudioContext is suspended; a plug-in that can't be stopped safely is left alone rather than destroyed under the
  audio thread.

## Threads

A plug-in built with shared memory and the exports below runs on two threads: its main-thread work (state,
presets, its interface, its own requests) on a Worker, and its audio on the AudioWorklet. Main-thread work then
never holds up audio. Other plug-ins run entirely on the audio thread. Check which with `plugin.threads`;
`plugin.oneThreadReason` says why, and the chain's `onLog` hears it too.

Two-thread plug-ins can also start their own threads with `pthread_create`; each runs in its own Worker.

To build a plug-in for two threads with the WASI SDK, target `wasm32-wasip1-threads` with `-pthread` and link with:

```
-Wl,--import-memory,--export-memory,--shared-memory
-Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align,--export=__wasi_init_tp
```

These exports let wclap-ts give the second instance its own stack and thread-local storage. That second instance is
wclap-ts's own arrangement, not part of WCLAP: wasi-threads has no way for a host to add a thread of its own, so
wclap-ts sets the thread up from these exports and checks the result. If anything doesn't match what it expects, the
plug-in runs on the audio thread alone instead. `docs/threads.md` explains it.

Adding a plug-in that runs on the audio thread to a playing chain starts it there, between two blocks. For
PICOH-101 the longest gap between blocks stays under 10 ms, below the 20 ms that counts as a stall (`npm run bench`).
A two-thread plug-in starts on its Worker.

## Security

A plug-in's audio code runs in WebAssembly and sees only its own memory and its bundle's files, read-only.

Its interface is a web page. By default it runs on your page's origin, so it can do anything a script on your page
can: use this for your own plug-ins. For plug-ins you didn't write, serve the same wclap-ts folder from a second
origin and pass it as `uiBase`: each interface then runs there, in a sandboxed frame, unable to reach your page or
navigate it. `frame.html` on that origin must be sent with `Cross-Origin-Resource-Policy: cross-origin`.

```ts
const chain = await createChain(context, { base: "/wclap/", uiBase: "https://ui.example.com/wclap/" });
```

`maxMemoryMB` (1024 by default) caps how far a plug-in's shared memory may grow.

## Your own graph in one worklet

For sends, buses, parallel tracks and latency compensation inside the audio thread, write the arrangement yourself
and let wclap-ts do the rest (loading, threads, events, interfaces, state). In your AudioWorklet module:

```ts
import { Chain, registerWclapProcessor, type HostContext, type Topology } from "wclap-ts/worklet";

class Mixer implements Topology {
    constructor(readonly host: HostContext) {} // transport, runner, this block's events, post, notesOut
    // add/remove as plug-ins come and go; message(data) for your routing;
    // render(blockStart, frames, inputs, outputs) runs the graph each block.
}
registerWclapProcessor("my-mixer", (host) => new Mixer(host));
```

Bundle that module (it imports wclap-ts, so it needs a bundler such as esbuild) and serve it beside your pages.

On the page:

```ts
import { createHost } from "wclap-ts";

const host = await createHost(context, { base: "/wclap/", module: "/my-mixer.js", processor: "my-mixer" });
const drums = await host.add("/plugins/Drums.wclap.tar.gz");
host.send({ tracks: [[drums.id]] }); // reaches Mixer.message
```

Each track can be a `Chain.fromHost(host)`: chains made that way share the host's events, transport and runner,
so held notes survive rerouting. `host.runner.run(slot, …)` handles a single plug-in's block anywhere else: bypass,
letting go of notes, flush, reset, fades and failure. `slot.ports.inputInfo` says which input is the main one and
which are sidechains.

The host keeps bypass state and the transport, and looks after any plug-in your render didn't run (main-thread time,
parameter changes, the stop handshake), so a plug-in that isn't routed yet can still be set up and removed.

`examples/graph-worklet.ts` is a complete mixer: tracks, a bus fed by sends, and each track delayed to the sample to
line up with the slowest.

## Building your own engine

`wclap-ts/core` has the parts underneath: `Plugin` runs one plug-in on whichever thread calls it, `Chain` runs
several per block, `EventQueue` and `Scheduler` carry timed events between threads without allocating, and
`MainThread`, `AudioSide` and `runThread` are the two-thread and spawned-thread pieces.

## Examples

`site/` is the project's website: getting started, and nine examples, each a page whose whole HTML file is shown
beside it, ready to copy. It installs this folder as its `wclap-ts`, so it always runs the code here:

```sh
npm run build
cd site && npm install && npm run setup && npm start   # then open http://127.0.0.1:8160/
```

`examples/` holds the development pages: `npm run serve`, then open `http://localhost:8150/examples/`.

## Source layout

| Folder         | What's in it                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`         | The package's entry points: `index.ts` (the page API), `core.ts` (`wclap-ts/core`), `worklet-api.ts` (`wclap-ts/worklet`)                                |
| `src/page/`    | What runs on the page: the host and plug-in classes, events, MIDI, interfaces, `loadWclap`, `isolate`, `alignLatency`                                    |
| `src/worklet/` | What runs on the audio thread: the worklet host, the `Topology` contract, `Chain`, and the per-plug-in `Runner`                                          |
| `src/threads/` | A plug-in's main role on a Worker, the control block between the two threads, threads the plug-in starts itself                                          |
| `src/plugin/`  | Hosting one WCLAP: opening the bundle, the wasm instance and memory, WASI, the CLAP host callbacks, and the plug-in's main-thread and audio-thread roles |
| `src/events/`  | The event queue between threads and the clock that times live events                                                                                     |
| `src/runtime/` | The files a site serves (`worklet.js`, `worker.js`, `thread.js`, `sw.js`, `frame.html`), all small                                                       |

## Development

Needs Node 22.18 or later (it runs the TypeScript directly).

```sh
npm install
npm run fixtures  # fetch the test plug-ins that aren't in the repo (npm test fetches any missing)
npm test          # Node's test runner
npm run check     # types, then Biome (lint and format)
npm run build
```

The examples and the site use [compost](https://github.com/charCulbert/compost) web components (knobs, a piano),
installed from GitHub. `npm run gen` regenerates the CLAP struct layouts from the headers in `external/clap/include`
(it fetches the WASI SDK's clang on first run).

## Thanks

- [Signalsmith Audio](https://signalsmith-audio.co.uk) (Geraint Luff), for WCLAP, the format this hosts.
- The [CLAP](https://github.com/free-audio/clap) authors and contributors, for CLAP and its SDK; the struct layouts
  here are generated from its headers (MIT).
- [Cmajor](https://cmajor.dev), for Pro54, the Cmajor example synth the A/B example loads (GPL-3.0, loaded from
  its own URL, not included here).
- André Michelle, for [Hive](https://github.com/andremichelle/open-webclap/tree/main/ports/hive), the note sequencer
  in the tests and examples (CC0-1.0), and for [open-webclap](https://github.com/andremichelle/open-webclap).
- [nakst's CLAP tutorial](https://nakst.gitlab.io/tutorial/clap-part-1.html), the layout the HeavyMain test plug-in
  follows.
