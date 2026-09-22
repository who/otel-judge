import type { JevRun, JevRunStatus } from "../agent/store";
import type { JevResult } from "./types";

/**
 * What the judge does when System One does not answer.
 *
 * The rule this module exists to enforce has one clause: nothing in here ever
 * invents a distribution. A missing key, a timed-out call, and a body that did
 * not parse all end the same way — a run recorded as having produced nothing,
 * and a marker saying so — because the PRD makes full distributions normative
 * input to System Two, and a fabricated prior is indistinguishable from a real
 * one the moment it reaches SQL and the demo board.
 *
 * It sits between the client and everything downstream deliberately: the client
 * knows how to fail, storage knows how to keep a row, and the translation
 * between the two is one place rather than repeated in each workflow step.
 */

/** The token for the one failure that means nobody was ever asked. */
export const MISSING_API_KEY = "missing_api_key";

/**
 * Why a call produced no priors, as a token rather than as prose.
 *
 * These strings are stored and then grouped by the demo channel, which makes
 * them durable values rather than messages: adding a token is additive, and
 * renaming one strands every row already written with the old spelling. The
 * `http_` family is mechanical on purpose — a 401 and a 429 are different
 * operational stories and neither should be flattened into the other.
 */
export type JevReason =
  | typeof MISSING_API_KEY
  | "timeout"
  | "network_error"
  | "malformed_response"
  | "invalid_request"
  | "unknown_error"
  | `http_${number}`;

/**
 * The one variable that decides whether System One can be reached at all.
 *
 * Declared here rather than imported from the client so that a caller wanting
 * to branch before it builds a request does not have to pull in the module that
 * knows how to send one.
 */
export interface JevKeyEnv {
  readonly TYPESAFE_API_KEY?: string;
}

/**
 * The key as it would travel, or the empty string when there is nothing to send.
 *
 * Trimming here is what makes a key of spaces the same thing as no key: a
 * secret set to whitespace by a copy-paste accident must not become
 * `Bearer    `, which reads to an operator as a rejected credential rather than
 * as a missing one.
 */
export function jevApiKey(env: JevKeyEnv): string {
  return env.TYPESAFE_API_KEY?.trim() ?? "";
}

/** Whether a call is worth attempting; the same check the client short-circuits on. */
export function isJevUsable(env: JevKeyEnv): boolean {
  return jevApiKey(env) !== "";
}

/**
 * The marker a degraded run hands downstream, carrying no answers of any kind.
 *
 * There is no field here that could hold a distribution, which is the point:
 * the judge prompt and the live snapshot both read this, and neither can be
 * handed a prior that never existed even by mistake.
 */
export interface JevUnavailable {
  available: false;
  reason: JevReason;
  status?: number;
}

/** Its opposite: priors exist, and the model that produced them is named. */
export interface JevAvailable {
  available: true;
  model: string;
}

export type JevAvailability = JevAvailable | JevUnavailable;

/**
 * The client's prose, matched once, in one place.
 *
 * The client reports failures in sentences because a human reading a workflow
 * history wants the sentence; this table is what turns those sentences into the
 * handful of values a machine groups by. The coupling is real and is pinned by
 * a test that drives every client failure path through here, so a reworded
 * failure fails loudly instead of quietly landing as `unknown_error`.
 */
const REASON_PREFIXES: readonly (readonly [string, JevReason])[] = [
  ["timed out", "timeout"],
  ["network error", "network_error"],
  ["malformed response", "malformed_response"],
  ["response body was not JSON", "malformed_response"],
  ["request could not be built", "invalid_request"],
];

/**
 * Name why this call failed, in the stable vocabulary.
 *
 * The prose is consulted before the status because a status alone would put a
 * body that arrived and did not parse under `http_200`, which is true of the
 * transport and useless to anyone counting how often System One answers with
 * something unusable.
 */
export function jevReason(failure: { reason: string; status?: number }): JevReason {
  if (failure.reason === MISSING_API_KEY) return MISSING_API_KEY;

  for (const [prefix, token] of REASON_PREFIXES) {
    if (failure.reason.startsWith(prefix)) return token;
  }

  return failure.status === undefined ? "unknown_error" : `http_${failure.status}`;
}

/**
 * Tell "nobody answered" apart from "the answer could not be used".
 *
 * Only a missing key is `unavailable`. A key that is present and rejected with
 * a 401 is an `error`, and the distinction is the whole value of the column: an
 * operator reading history needs to know whether to go configure something or
 * to go argue with the API.
 */
function runStatusFor(reason: JevReason): JevRunStatus {
  return reason === MISSING_API_KEY ? "unavailable" : "error";
}

/**
 * Turn any call outcome into the single row that records it.
 *
 * One function covers both paths so that a success and a failure cannot drift
 * into being written by different code with different ideas about what belongs
 * in the row. A failed run carries no model and no latency: naming the model
 * that did not answer would suggest it did, and timing a call that never
 * happened is a number with nothing behind it.
 *
 * The packet id and the timestamp are arguments rather than fields of the
 * result because a result knows what System One said, not which packet it was
 * asked about or when the caller decided the attempt was over.
 */
export function toJevRunRow(packetId: string, result: JevResult, createdAt: string): JevRun {
  if (result.ok) {
    return {
      packet_id: packetId,
      model: result.model,
      status: "ok",
      reason: null,
      latency_ms: result.latency_ms,
      created_at: createdAt,
    };
  }

  const reason = jevReason(result);
  return {
    packet_id: packetId,
    model: null,
    status: runStatusFor(reason),
    reason,
    latency_ms: null,
    created_at: createdAt,
  };
}

/**
 * What the next step is told, whether or not there are priors to tell it about.
 *
 * The evaluation always continues: the PRD says an unreachable System One is
 * logged and the judge is still attempted with whatever state exists. This is
 * the value that makes "attempted with no priors" expressible without anything
 * standing in for the priors.
 */
export function toJevMarker(result: JevResult): JevAvailability {
  if (result.ok) return { available: true, model: result.model };

  const marker: JevUnavailable = { available: false, reason: jevReason(result) };
  return result.status === undefined ? marker : { ...marker, status: result.status };
}

/**
 * The live snapshot's coarser view of the same fact.
 *
 * `JudgeState` offers two values where the row offers three, because a
 * connected client is being told whether priors exist, not being given an
 * incident report. Every failure collapses to `unavailable` there and the
 * reason stays in SQL, where the length of it does no harm.
 */
export function jevStateStatus(result: JevResult): "ok" | "unavailable" {
  return result.ok ? "ok" : "unavailable";
}
