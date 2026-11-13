// When an event should play, in audio frames, from when it happened (performance.now() time: a MIDI message's
// timeStamp, or the moment of a call). Every event lands one fixed offset after its source time, so spacing is kept
// and jitter stays near zero: the offset only rises when an event would otherwise be late, and eases back slowly.
export class Clock {
    readonly context: BaseAudioContext;
    // Seconds added to every event, so it reaches the audio side before its frame comes up.
    lead: number;
    // Frames from source time (in frames) to play time, or NaN until the first event.
    #offset = Number.NaN;
    #lastSource = 0;

    constructor(context: BaseAudioContext, lead: number) {
        this.context = context;
        this.lead = lead;
        // A suspended context stops its clock while performance.now() runs on: start the correlation again.
        context.addEventListener("statechange", () => {
            this.#offset = Number.NaN;
        });
    }

    frameAt(sourceMs: number): number {
        const c = this.context;
        const rate = c.sampleRate;
        const stamp = "getOutputTimestamp" in c ? (c as AudioContext).getOutputTimestamp() : undefined;
        if (!stamp?.performanceTime || stamp.contextTime === undefined)
            return Math.round((c.currentTime + this.lead) * rate);
        // The earliest frame this event can still make: the render clock's position now, plus the lead.
        const nowMs = performance.now();
        const earliest = (c.currentTime + this.lead) * rate + Math.max(0, sourceMs - nowMs) * (rate / 1000);
        const audible = (stamp.contextTime + (sourceMs - stamp.performanceTime) / 1000) * rate;
        const source = (sourceMs * rate) / 1000;
        const needed = Math.max(earliest, audible + this.lead * rate) - source;
        // Ease down 1 ms per second of source time: well above clock drift, well below audible change.
        const eased = this.#offset - Math.max(0, sourceMs - this.#lastSource) * (rate / 1e6);
        this.#offset = Number.isNaN(this.#offset) ? needed : Math.max(needed, eased);
        this.#lastSource = Math.max(this.#lastSource, sourceMs);
        return Math.round(source + this.#offset);
    }
}
