import {
  MAX_RECENT_PACKETS,
  type HumanLabel,
  type JevRun,
  type PacketStatus,
  type StoredAnswer,
  type StoredPacket,
  type StoredVerdict,
} from "./store";

/**
 * The shapes the callable history API speaks, kept apart from the Agent itself.
 *
 * A channel — the browser demo, a Slack app, a replay script — codes against
 * these names and nothing else. They live in their own module so a consumer can
 * import the contract without importing a Durable Object class it has no way to
 * construct, and so a change to the Agent's internals is visibly not a change
 * to what a client was promised.
 */

/**
 * What a human may say about a judged packet.
 *
 * Frozen because this vocabulary is durable stored data: a row written last
 * month still carries one of these strings, so the list may gain a member and
 * may not quietly lose or rename one. `wrong` is here alongside the severities
 * because the most valuable thing a human can tell this system is that the
 * judge got it wrong, and forcing that into a severity bucket would record a
 * severity nobody meant and lose the disagreement entirely.
 */
export const HUMAN_LABELS = Object.freeze(["sev0", "sev1", "sev2", "noise", "wrong"] as const);

/** One of the five labels, as a type, so a caller in TypeScript cannot miss. */
export type HumanLabelName = (typeof HUMAN_LABELS)[number];

/** Long enough for a sentence of context, short enough that nobody files a report here. */
export const MAX_LABEL_NOTE_LENGTH = 500;

/** What a client gets when it asks for history without saying how much. */
export const DEFAULT_HISTORY_LIMIT = 20;

/** Asking for nothing is a mistake rather than an instruction, so it yields one row. */
export const MIN_HISTORY_LIMIT = 1;

/** Whether a value is one of the labels a human is allowed to attach. */
export function isHumanLabelName(value: unknown): value is HumanLabelName {
  return typeof value === "string" && (HUMAN_LABELS as readonly string[]).includes(value);
}

/**
 * Fold any number a client sends into the range history is willing to serve.
 *
 * Clamping rather than rejecting is deliberate: a paging control that computes
 * a limit of zero at the end of a list, or a caller that asks for everything,
 * should get a sensible page instead of an error it has to special-case. A
 * value that is not a number at all has no clamped meaning, so it falls back to
 * the default rather than to either end.
 */
export function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.max(Math.floor(limit), MIN_HISTORY_LIMIT), MAX_RECENT_PACKETS);
}

/**
 * One line of history: enough to choose a packet, never the packet itself.
 *
 * `severity` is the judge's conclusion where there is one and null where there
 * is not, which is what lets a failed or still-running packet keep its place in
 * the list instead of disappearing from it.
 */
export interface HistoryRow {
  packet_id: string;
  service: string;
  env: string;
  window_start: string;
  window_end: string;
  received_at: string;
  status: PacketStatus;
  severity: string | null;
}

/**
 * Everything stored about one packet, as a client receives it.
 *
 * `jev_answers` carries each question's complete probability vector and its
 * noul mass, not an argmax: the live snapshot deliberately publishes neither,
 * so this deliberate read is the only place a distribution is ever handed over
 * and it must hand over the whole of one.
 */
export interface PacketDetail {
  packet: StoredPacket;
  jev_run: JevRun | null;
  jev_answers: StoredAnswer[];
  verdict: StoredVerdict | null;
  labels: HumanLabel[];
}

/** Why a label was not written; stable enough for a client to branch on. */
export type LabelRejection = "unknown_label" | "note_too_long" | "unknown_packet";

/**
 * Raised when a label is refused, carrying which rule refused it.
 *
 * Thrown rather than returned because a rejected label is a caller bug, not an
 * outcome: every one of these means the client sent something it could have
 * checked itself against `HUMAN_LABELS` and `MAX_LABEL_NOTE_LENGTH`. The name
 * and message survive the RPC boundary even where the class does not, so a
 * channel that only sees an `Error` can still tell a human what went wrong.
 */
export class LabelRejectedError extends Error {
  readonly code: LabelRejection;

  constructor(code: LabelRejection, message: string) {
    super(message);
    this.name = "LabelRejectedError";
    this.code = code;
  }
}
