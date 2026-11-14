// Memory the page and the audio thread share, when the page is cross-origin isolated. Without isolation there is no
// SharedArrayBuffer at all: the same structures sit in an ordinary ArrayBuffer, private to one side, and what must
// cross goes by postMessage.
export type MaybeShared = SharedArrayBuffer | ArrayBuffer;

export const canShare = (): boolean => typeof SharedArrayBuffer === "function";

export const sharedBuffer = (bytes: number): MaybeShared =>
    canShare() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
