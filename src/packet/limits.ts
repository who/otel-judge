/**
 * The largest request body any layer will accept, in bytes.
 *
 * 128 KiB. A packet larger than this is a producer bug or an attack, never real
 * telemetry: the validator's array and string caps put a well-formed packet
 * orders of magnitude below it.
 *
 * The number lives beside the packet contract rather than beside the Worker
 * because two layers enforce it and only one of them is a door. The door caps
 * the stream before anything is decoded; the Agent re-checks the text it was
 * handed, so a caller that reached the Agent by some other road is bounded too.
 * Keeping the constant here is what lets the Agent share it while importing
 * nothing from `src/worker/`.
 */
export const MAX_BODY_BYTES = 131072;
