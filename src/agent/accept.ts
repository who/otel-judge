import type { PacketErrorCode } from "../packet/errors";
import { MAX_BODY_BYTES } from "../packet/limits";
import type { Packet } from "../packet/types";
import { validatePacket } from "../packet/validate";
import {
  DuplicatePacketError,
  getPacketStatus,
  hasPacket,
  insertPacket,
  type PacketStatus,
  type SqlTag,
} from "./store";

/**
 * What accepting a packet needs from whoever is holding the Agent.
 *
 * Storage arrives as a callable and time arrives as a function, so the whole
 * decision below can be exercised without a request, a response, or a clock
 * that moves while the assertions are being written.
 */
export interface AcceptContext {
  sql: SqlTag;
  now?: () => Date;
}

/**
 * The four things that can become of an offered packet.
 *
 * Every one of them is an ordinary answer a caller renders, not an exception:
 * producers are other people's programs, and being handed a truncated body or
 * the same id twice is a Tuesday rather than a fault. The only thing that
 * escapes as a throw is storage refusing a packet that already validated, which
 * is the one case where the judge, not the producer, is the broken party.
 */
export type AcceptOutcome =
  | { kind: "accepted"; packet: Packet; received_at: string }
  | { kind: "duplicate"; packet_id: string; status: PacketStatus }
  | { kind: "invalid"; code: PacketErrorCode; errors: string[] }
  | { kind: "too_large"; limit: number };

/**
 * Whether the body is over the shared cap, measured in the bytes the cap counts.
 *
 * The code-unit comparison runs first because a string can never encode to
 * fewer UTF-8 bytes than it has UTF-16 units, so an obviously huge body is
 * turned away without being copied into a buffer at all. Only a body that could
 * still fit is encoded, which bounds that copy by the cap itself.
 */
function exceedsLimit(body: string): boolean {
  if (body.length > MAX_BODY_BYTES) return true;
  return new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES;
}

/**
 * Report a packet id that is already stored, carrying the status it reached.
 *
 * A row cannot disappear between the read that found it and this one — a
 * Durable Object runs one thing at a time and nothing deletes packets — so the
 * fallback exists only to keep the status a narrowed value rather than a
 * nullable one the response shape would have to explain.
 */
function duplicate(sql: SqlTag, packetId: string): AcceptOutcome {
  return {
    kind: "duplicate",
    packet_id: packetId,
    status: getPacketStatus(sql, packetId) ?? "accepted",
  };
}

/**
 * Decide what becomes of one offered body: size, shape, novelty, then storage.
 *
 * The order is the point. Size is checked against the raw text so an oversize
 * body is refused without ever reaching `JSON.parse`; parsing is separated from
 * validation so a producer sending broken JSON is told that rather than being
 * handed a field-by-field critique of nothing; and the dedupe read happens
 * before the insert so a repeat is an answer instead of a caught constraint.
 *
 * Nothing here evaluates the packet or even knows evaluation exists. What this
 * function does is exactly the work that must finish before a producer can be
 * told its packet is safe, and deliberately not one step more, because every
 * step added here is added to the latency of every producer's write path.
 */
export function acceptPacket(ctx: AcceptContext, body: string): AcceptOutcome {
  if (exceedsLimit(body)) return { kind: "too_large", limit: MAX_BODY_BYTES };

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    // The parser's own message quotes the offending text back, and that text is
    // an untrusted body, so the diagnostic is fixed and says what to send instead.
    return {
      kind: "invalid",
      code: "malformed_payload",
      errors: ["packet: expected a JSON object, received a body that is not valid JSON"],
    };
  }

  const result = validatePacket(payload);
  if (!result.ok) return { kind: "invalid", code: result.code, errors: result.errors };

  const { packet } = result;
  const { sql } = ctx;
  if (hasPacket(sql, packet.packet_id)) return duplicate(sql, packet.packet_id);

  // Taken here rather than by the caller: received_at is when the judge took
  // responsibility for the packet, which is this moment and not the moment the
  // producer stamped on it or the moment a door started reading the stream.
  const receivedAt = (ctx.now?.() ?? new Date()).toISOString();
  try {
    insertPacket(sql, packet, receivedAt);
  } catch (error) {
    // Two requests carrying one id can both pass the read above. The primary
    // key settles which of them stored it, and the loser reports a duplicate
    // rather than a 500: one row exists, which is what the producer was asking
    // for, so nothing here failed from where it is standing.
    if (error instanceof DuplicatePacketError) return duplicate(sql, packet.packet_id);
    throw error;
  }

  return { kind: "accepted", packet, received_at: receivedAt };
}
