import { jevStateStatus, toJevRunRow } from "../jev/degraded";
import type { EvaluateResult } from "../workflow/evaluate";
import type { JudgeState } from "./state";
import {
  getPacketStatus,
  hasPacket,
  recordJevAnswers,
  recordJevRun,
  recordVerdict,
  setPacketStatus,
  type JevAnswer,
  type SqlTag,
} from "./store";

/**
 * What an Agent does with a workflow that has stopped, and nothing else.
 *
 * Two jobs live here so the Agent can keep its promise of depending on nothing
 * but the SDK and its own folder: turning an evaluation into rows, and turning
 * it into the one terminal snapshot clients are shown. Both need to know what an
 * `EvaluateResult` looks like, and putting that knowledge in one module means
 * the Agent never imports the pipeline to find out.
 *
 * The whole write is one pass at the end of a run rather than a write per step.
 * A step that retries half an hour later would otherwise leave history holding
 * half of one attempt and half of another, and no reader could tell which half
 * was current. The per-step writes are the live merges, which are disposable by
 * design and can be replayed without consequence.
 */

/**
 * Why a run row exists for a packet whose evaluation never finished.
 *
 * Deliberately not one of System One's own reasons. `http_401` and `timeout`
 * are things that happened to a call; this token says no call outcome was ever
 * established for this packet, which is a different fact and must not be
 * counted alongside them by anything grouping the column.
 */
export const WORKFLOW_FAILED_REASON = "workflow_failed";

/**
 * How one evaluation ended, as the Agent learned of it.
 *
 * The failure arm carries the packet id explicitly because a failed run has no
 * result to read one out of: the Agent recovers it from the workflow it started
 * and hands it over, rather than this module going looking for it.
 */
export type EvaluationOutcome =
  | { ok: true; result: EvaluateResult }
  | { ok: false; packet_id: string; reason: string };

/**
 * Whether the write happened, or the packet it was about is not stored here.
 *
 * An unknown id is reported rather than thrown and rather than inserted: a
 * completion for a packet this Agent has no row for is a routing fault worth
 * logging, and the one thing it must never become is a phantom packet whose
 * history begins with its verdict.
 */
export type PersistOutcome = "persisted" | "unknown_packet";

/** One answer as a row: the vector whole, never the argmax standing in for it. */
function toAnswerRows(result: EvaluateResult, createdAt: string): JevAnswer[] {
  if (!result.jev.ok) return [];

  return result.jev.answers.map((answer) => ({
    question_key: answer.key,
    // The distribution and the mass System One placed on no offered outcome are
    // what System Two reasoned over, so they are what history has to be able to
    // show. `argmax` rides along as the convenience it is.
    answer: { distribution: answer.distribution, noul: answer.noul, argmax: answer.argmax },
    created_at: createdAt,
  }));
}

/**
 * Write everything one finished evaluation leaves behind, in one pass.
 *
 * Every write is an upsert or a replace, which is what makes a replayed
 * completion safe: the second pass writes the same run, the same answers and
 * the same verdict over the first, and a reader still finds exactly one of each.
 * The packet's status moves last so a client reacting to it finds the rows
 * already there.
 *
 * A failed run still writes a row. The alternative is a packet whose history
 * simply stops, which reads as "nothing was tried" when what happened is that
 * everything was tried and the judge never spoke.
 */
export function persistEvaluation(
  sql: SqlTag,
  outcome: EvaluationOutcome,
  now: Date = new Date(),
): PersistOutcome {
  const packetId = outcome.ok ? outcome.result.packet_id : outcome.packet_id;
  if (!hasPacket(sql, packetId)) return "unknown_packet";

  const createdAt = now.toISOString();

  if (!outcome.ok) {
    // A late failure for a packet that already completed is a duplicate
    // notification, not news. Overwriting a real run record with the
    // placeholder below would lose the only account of what System One said.
    if (getPacketStatus(sql, packetId) === "complete") return "persisted";

    recordJevRun(sql, {
      packet_id: packetId,
      model: null,
      status: "error",
      reason: WORKFLOW_FAILED_REASON,
      latency_ms: null,
      created_at: createdAt,
    });
    setPacketStatus(sql, packetId, "failed");
    return "persisted";
  }

  const { result } = outcome;
  recordJevRun(sql, toJevRunRow(packetId, result.jev, createdAt));
  // Written even when the list is empty: replacing the answers is how a retry
  // stops an earlier attempt's distributions from sitting beside this one's.
  recordJevAnswers(sql, packetId, toAnswerRows(result, createdAt));

  // A run that stopped at System One has no verdict, and writing a row for the
  // judgement nobody made would put a severity in history that no model graded.
  // The run row above is the whole account of what happened to this packet.
  const judged = result.verdict;
  if (judged === undefined) {
    setPacketStatus(sql, packetId, "failed");
    return "persisted";
  }

  recordVerdict(sql, packetId, {
    severity: judged.verdict.severity,
    summary: judged.verdict.summary,
    critique: judged.verdict.critique,
    next_action: judged.verdict.next_action,
    disagrees_with_prior: judged.verdict.disagrees_with_prior,
    model: judged.model,
    // The reply exactly as it arrived, which is what keeps the reasoning trail
    // readable after the parser has smoothed it into columns.
    raw: judged.verdict.raw,
    created_at: createdAt,
  });
  setPacketStatus(sql, packetId, "complete");
  return "persisted";
}

/**
 * The last snapshot a run produces, small enough to broadcast to strangers.
 *
 * The demo origin is public and every connected socket sees this, so what
 * crosses is a severity and a one-line summary — never a distribution, never a
 * prompt, never the critique. A client that wants the reasoning asks for the
 * packet's history, which is a deliberate request rather than a broadcast.
 *
 * A failed run publishes no verdict at all, not an empty one: `last_verdict` is
 * left exactly as it was so the board keeps showing the last thing actually
 * judged instead of blanking on a run that never reached an opinion.
 */
export function terminalState(
  outcome: EvaluationOutcome,
  now: Date = new Date(),
): Record<string, unknown> {
  const updatedAt = now.toISOString();

  if (!outcome.ok) {
    return {
      stage: "failed",
      last_packet_id: outcome.packet_id,
      updated_at: updatedAt,
    } satisfies Partial<JudgeState>;
  }

  const { result } = outcome;
  const judged = result.verdict;

  // A run that never reached System Two publishes the failed stage and leaves
  // `last_verdict` alone, for the same reason a failed run does: the board goes
  // on showing the last packet actually judged rather than blanking on one that
  // nobody graded.
  if (judged === undefined) {
    return {
      stage: "failed",
      last_packet_id: result.packet_id,
      jev_status: jevStateStatus(result.jev),
      updated_at: updatedAt,
    } satisfies Partial<JudgeState>;
  }

  return {
    stage: "complete",
    last_packet_id: result.packet_id,
    last_verdict: {
      severity: judged.verdict.severity,
      summary: judged.verdict.summary,
    },
    jev_status: jevStateStatus(result.jev),
    updated_at: updatedAt,
  } satisfies Partial<JudgeState>;
}

/**
 * Read a workflow's output back as an evaluation, or refuse to.
 *
 * The completion callback types its result `unknown` because a workflow can
 * return anything, and an Agent that has been redeployed can be handed the
 * output of a run started by an older build. The fields checked are the ones
 * the write pass dereferences, so anything that passes here can be persisted
 * without a second guess, and anything that does not is reported rather than
 * turned into a half-written row.
 */
export function readEvaluateResult(value: unknown): EvaluateResult | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Partial<EvaluateResult>;
  if (typeof candidate.packet_id !== "string" || candidate.packet_id === "") return null;
  if (typeof candidate.jev !== "object" || candidate.jev === null) return null;

  // An evaluation that stopped at System One carries no verdict, and refusing it
  // here would throw away the only account of a run that did happen. What is
  // still refused is a verdict that is present and unreadable.
  const judged = candidate.verdict;
  if (judged !== undefined) {
    if (typeof judged !== "object" || judged === null) return null;
    if (typeof judged.verdict !== "object" || judged.verdict === null) return null;
  }

  return candidate as EvaluateResult;
}
