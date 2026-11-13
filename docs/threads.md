# Threads

A CLAP plug-in has two roles, main and audio, each called from one thread. In a browser the audio thread is the
AudioWorklet, which must never wait. Main-thread work (loading state, building wavetables, answering its interface)
can take milliseconds, so wclap-ts runs it on a Worker when the plug-in allows it.

That needs two WebAssembly instances of the plug-in over one shared memory: the first on the Worker, the second on
the AudioWorklet. This file describes how the second one is set up, what it relies on, and what happens when that
isn't there.

## What wasi-threads provides, and what it doesn't

wasi-threads gives a plug-in one way to start a thread: its libc calls the host's `thread-spawn` with an argument it
prepared (a stack, thread-local storage and a thread record), and the host runs `wasi_thread_start(tid, arg)` on a
fresh instance. wclap-ts supports this: threads a plug-in starts with `pthread_create` run in their own Workers
(`src/threads/plugin-spawned-threads.ts`).

There is no way for a host to add a thread of its own, since only the plug-in's libc can prepare that argument. The
AudioWorklet's instance is such a thread. So wclap-ts sets it up itself, from exports the plug-in opts into.

## How the second instance is set up

`Instance.attach` in `src/plugin/wasm-instance.ts`:

1. The first instance, on the Worker, allocates a stack and a thread-local block with the plug-in's own `malloc`,
   sized by `__tls_size` and aligned by `__tls_align`.
2. The second instance is created over the same memory. It skips `_initialize`, since the memory is already set up.
3. It sets `__stack_pointer` to its own stack, calls `__wasm_init_tls` on its own block, and calls `__wasi_init_tp`,
   which fills in libc's thread record for this instance.
4. `__wasi_init_tp` gives every thread record the main thread's ID, `0x3fffffff` (wasi-libc,
   `libc-top-half/musl/src/env/__init_tls.c`, chosen so it never matches an ID a host hands out). wclap-ts finds
   that value in the new block and replaces it with an ID from the plug-in's thread-ID counter, the same counter
   `thread-spawn` uses, so no two threads share an ID. If the value isn't there exactly once, attaching fails.
5. The host functions are installed in the same order on both instances, and their table slots are compared.

A test checks that attaching writes nothing outside the new thread's own block (`test/threads.test.ts`).

## What it relies on

- The plug-in exports `__stack_pointer`, `__wasm_init_tls`, `__tls_size`, `__tls_align` and `__wasi_init_tp`,
  imports a shared memory, and exports `malloc`. These are linker flags, not code (see the README).
- wasi-libc keeps the thread ID in the thread record, in the thread-local block, as `0x3fffffff` until changed.

The second instance doesn't go through `pthread_create`, so libc's list of threads doesn't include it. Nothing in
CLAP's audio role walks that list. A plug-in that uses thread-local destructors or `pthread_self` comparisons on its
audio thread is the case to watch; none of the plug-ins tested so far does.

## When it doesn't hold

Any check failing (a missing export, memory that isn't shared, the ID not found exactly once, the table slots
differing) makes the plug-in run entirely on the audio thread, as one instance. That always works, at the cost of
main-thread work running between audio blocks. `plugin.threads` tells which happened.

A plug-in on the audio thread alone can't start threads: an AudioWorklet can't block, and the plug-in's
`pthread_join` (or any contended lock) would trap there. Its `pthread_create` fails instead.

## Measured

`test/fixtures/heavy-main` rebuilds a 64-table wavetable bank whenever its state is loaded, about 150 ms of
main-thread work. Loading its state five times while it plays, in Chrome on an M1 Pro Mac, 48 kHz, 128-frame
blocks (`stats` from `onStats`), measured by hand rather than by a script in this repo:

|                                                        | Stalls (gaps over 20 ms) | Longest gap between blocks | Longest block |
| ------------------------------------------------------ | ------------------------ | -------------------------- | ------------- |
| Two threads, run 1                                     | 0                        | 6 ms                       | 1 ms or less  |
| Two threads, run 2                                     | 0                        | 6 ms                       | 1 ms or less  |
| One thread                                             | 5                        | 162 ms                     | 1 ms or less  |
| An idle chain (HeadlessGain, no loads), for comparison | 0                        | 7 ms                       | 1 ms or less  |

With one thread the state loads run on the audio thread between blocks, so the audio waits for them; with two
they run on the Worker and the audio doesn't notice.

`npm run heavy` runs the same comparison in Node with worker_threads. There the two-thread side shows occasional
6-12 ms blocks and some stalls that Chrome doesn't; Node's scheduling of the harness, not the plug-in, is the
likely cause, so take Chrome's figures as the ones that matter.
