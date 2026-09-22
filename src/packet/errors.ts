import type { Packet } from "./types";

/**
 * The stable machine-readable reasons a packet can be turned away.
 *
 * These are the codes a door puts in the `error` field of its JSON body, so
 * they are part of the wire contract and are never reworded to suit a message.
 * Three are enough because they map to three different producer fixes: send a
 * JSON object, upgrade the schema version, or correct the fields named in
 * `errors`.
 */
export type PacketErrorCode =
  | "malformed_payload"
  | "unsupported_schema_version"
  | "invalid_packet";

/**
 * What validation returns instead of what it throws.
 *
 * A rejected packet is an ordinary outcome — producers are other people's
 * programs and they will get it wrong — so the failure branch is a value the
 * caller renders, not an exception it has to remember to catch. `errors` is a
 * list of human-readable strings, each naming the exact JSON path that failed,
 * and it is never empty when `ok` is false.
 */
export type ValidationResult =
  | { ok: true; packet: Packet }
  | { ok: false; code: PacketErrorCode; errors: string[] };
