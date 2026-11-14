// The contract between the worklet host and an arrangement of plug-ins (a Chain, or your own graph).
import type { Scheduler } from "../events/event-queue.ts";
import type { Event, Transport } from "../plugin/plugin-types.ts";
import type { Audio, Runner, Slot } from "./plugin-runner.ts";

// Where a chain takes each block's events from: the host's scheduler, or one block's events shared by several
// chains (a graph's tracks).
export type EventSource = Pick<Scheduler, "take">;

// What the host gives an arrangement (registerWclapProcessor's make). The host owns the plug-ins, their bypass state,
// the transport (it advances it after each block) and the Runner, and looks after any plug-in the arrangement
// didn't run in a block.
export interface HostContext {
    readonly sampleRate: number;
    readonly transport: Transport;
    readonly runner: Runner;
    // This block's events: take() gives every caller the same block, so several chains can share it.
    readonly events: EventSource;
    // Whatever the page passed as HostOptions.topology.
    readonly options: unknown;
    // To the page, as the host's "message" event.
    post(data: unknown): void;
    // Notes and MIDI leaving the arrangement (MIDI out), at frames from `blockStart`.
    notesOut(blockStart: number, notes: readonly Event[], count: number): void;
}

// An arrangement of plug-ins. Chain is one; write your own for a graph, and register it with registerWclapProcessor
// (wclap-ts/worklet).
export interface Topology {
    add(slot: Slot, index?: number): void;
    remove(id: number): void;
    render(blockStart: number, frames: number, inputs: Audio, outputs: Audio): void;
    // The host has bypassed or brought back a plug-in; this is for what it means to the routing.
    setEnabled?(id: number, enabled: boolean): void;
    // Reordering, for an arrangement where order means something.
    move?(id: number, index: number): void;
    // Whatever the page sends with host.send(data): routing, levels, anything the arrangement defines.
    message?(data: unknown): void;
}
