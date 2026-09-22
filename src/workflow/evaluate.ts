import type { WorkflowStepConfig } from "cloudflare:workers";
import type { JudgeState, Stage } from "../agent/state";
import { jevStateStatus } from "../jev/degraded";
import type { SystemOneState } from "../jev/request";
import type { JevFailure, JevResult } from "../jev/types";
import type { JudgeResult } from "../llm/judge";
import type { Packet } from "../packet/types";
import type { PacketSummary } from "./summarize";

/**
 * The evaluation pipeline as arithmetic on a step object, and nothing else.
 *
 * Every branch a packet can take between arriving and being judged lives in
 * `runEvaluate` rather than in the workflow class, because a `WorkflowEntrypoint`
 * subclass can only be exercised by starting a real workflow and the Workers test
 * pool offers no harness for that. A plain function taking the step as an argument
 * is drivable by a fake in a few lines, so the sequencing rule and the retry
 * policies are assertions rather than hopes. The class that binds the real
 * dependencies is deliberately too thin to hold a decision.
 */

/** The three steps, named once so the names cannot drift between config and call. */
export type EvaluateStepName = "summarize" | "jev" | "judge";

/**
 * The order the steps run in.
 *
 * Exported because the ordering is a contract, not an implementation detail: a
 * judge asked before System One answers is a different product, and a test that
 * cannot name the expected order cannot defend the one that matters.
 */
export const STEP_NAMES: readonly EvaluateStepName[] = Object.freeze([
  "summarize",
  "jev",
  "judge",
] as const);

/**
 * What each step is allowed to cost before it gives up.
 *
 * Retry ownership sits here and nowhere else. The System One client makes exactly
 * one attempt per call by design, so a loop inside it would multiply invisibly
 * against these numbers and turn a bad minute for the API into a much worse one.
 *
 * Summarize is configured with no retries rather than left to the platform
 * default, and the difference is the whole point: the default would run a pure,
 * deterministic function five more times to watch it fail five more times in
 * exactly the same way. A summarize failure is a defect in this repository, and
 * the fastest useful thing to do with it is surface it.
 *
 * The two model-shaped steps carry the same retry count and different delays
 * because they fail differently. System One is an HTTP call that is either
 * answering or not, so a second's grace is enough to tell a blip from an outage;
 * the Workers AI judge is more often busy than absent, and giving it two seconds
 * before the first retry is what stops three attempts landing inside the same
 * spike of load.
 */
export const STEP_RETRIES: Readonly<Record<EvaluateStepName, WorkflowStepConfig>> = Object.freeze({
  summarize: { retries: { limit: 0, delay: 0 } },
  jev: { retries: { limit: 2, delay: "1 second", backoff: "exponential" } },
  judge: { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" } },
});

/**
 * The live stage each completed step puts the packet in.
 *
 * Mapped against the Agent's own `Stage` union so a milestone can never announce
 * a stage no client knows how to read. The two terminal stages are absent on
 * purpose: this module finishes when the judge has spoken, and whether that
 * becomes `complete` or `failed` is decided by whoever persists the result.
 */
export const STEP_STAGES: Readonly<Record<EvaluateStepName, Stage>> = Object.freeze({
  summarize: "summarized",
  jev: "jev",
  judge: "judging",
});

/**
 * What the workflow is started with.
 *
 * The whole validated packet travels, not its id. A step that retries half an
 * hour after the first attempt must not depend on the Agent still holding the
 * row, and re-reading storage from inside a step would make the retry a database
 * question rather than a model one.
 */
export interface EvaluatePayload {
  packet: Packet;
}

/**
 * One step boundary, reported as it is crossed.
 *
 * Small on purpose: which packet moved, which step moved it, and what to call
 * the result. `jev_status` is the one exception and it rides only on the jev
 * milestone, because whether priors exist is the fact a watching client most
 * wants at that boundary and the alternative is making it wait for the verdict
 * to learn that System One never answered. It is the coarse two-valued view, not
 * the reason: the reason is an incident detail that belongs in SQL.
 */
export interface EvaluateMilestone {
  packet_id: string;
  step: EvaluateStepName;
  stage: Stage;
  jev_status?: "ok" | "unavailable";
}

/**
 * The milestone as a partial snapshot, ready to merge into published state.
 *
 * A partial rather than a whole state because two packets can be in flight on
 * one Agent: a full `setState` built from a stale read would quietly undo the
 * other packet's progress, whereas merging three or four keys leaves whatever
 * this milestone has no opinion about exactly as it was. Nothing derived from
 * the summary, the distributions, or the prompts is in here, and there is no
 * branch that could put one in: state is broadcast to every connected client.
 */
export function milestoneState(
  milestone: EvaluateMilestone,
  now: Date = new Date(),
): Record<string, unknown> {
  // Every merge refreshes `updated_at` so a client can tell a stage that was
  // reasserted from one that has been sitting still.
  return {
    stage: milestone.stage,
    last_packet_id: milestone.packet_id,
    updated_at: now.toISOString(),
    ...(milestone.jev_status === undefined ? {} : { jev_status: milestone.jev_status }),
  } satisfies Partial<JudgeState>;
}

/**
 * Everything one evaluation produced, assembled once.
 *
 * `verdict` is the judge's whole result rather than its verdict field alone,
 * because the model that answered is stored beside the prose and asking the
 * environment for it a second time would let a pin change between the call and
 * the row. It is absent exactly when the judge was never asked: System Two
 * grounds its verdict in System One's distributions, so a packet System One
 * never answered for has no verdict rather than one reached without priors.
 * `failed_at` names the step that ended the run early — today only `jev` can do
 * that — so a reader can tell a degraded evaluation from a clean one without
 * re-deriving it from the union.
 */
export interface EvaluateResult {
  packet_id: string;
  summary: PacketSummary;
  jev: JevResult;
  verdict?: JudgeResult;
  failed_at?: EvaluateStepName;
}

/**
 * The work the three steps actually do, supplied rather than imported.
 *
 * `onProgress` is optional and defaults to doing nothing, which is what lets the
 * orchestration run in isolation: a test asserting that the judge is never asked
 * without priors should not have to stand up a state broadcaster to say what it
 * means.
 */
export interface EvaluateDeps {
  summarize: (packet: Packet) => PacketSummary;
  callSystemOne: (state: SystemOneState) => Promise<JevResult>;
  judge: (summary: PacketSummary, jev: JevResult) => Promise<JudgeResult>;
  onProgress?: (milestone: EvaluateMilestone) => void | Promise<void>;
}

/**
 * The only part of a workflow step this module needs.
 *
 * Narrowed to the one method so the orchestration stays runtime-independent and a
 * fake is three lines rather than a stub of nine unused callbacks. The signature
 * mirrors the real `do` exactly, including the serialisability constraint, so an
 * `AgentWorkflowStep` satisfies it without a cast.
 */
export interface EvaluateStep {
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/**
 * A retryable System One failure, dressed as a rejection so the engine retries it.
 *
 * The client reports every failure as a value, which is right for a caller
 * deciding what to do and wrong for a durable step: a step that returns has
 * succeeded, and a returned failure would spend the retry budget on nothing. The
 * typed failure rides along on the error so the reason survives the round trip
 * and the judge is told what went wrong rather than merely that something did.
 */
class JevStepFailure extends Error {
  readonly failure: JevFailure;

  constructor(failure: JevFailure) {
    super(failure.reason);
    this.name = "JevStepFailure";
    this.failure = failure;
  }
}

/**
 * Turn whatever the jev step rejected with back into a failure the judge can read.
 *
 * A `JevStepFailure` carries its own answer. Anything else is a throw from a seam
 * that was supposed to return a union — a bug here or a runtime fault — and it is
 * reported as non-retryable because the retry budget that would have helped has
 * already been spent by the time this runs.
 */
function toJevFailure(error: unknown): JevFailure {
  if (error instanceof JevStepFailure) return error.failure;

  const message = error instanceof Error ? error.message : String(error);
  const reason = message === "" ? "the System One step failed without a reason" : message;
  return { ok: false, retryable: false, reason };
}

/** What a caller that has not wired up progress reporting gets. */
async function noProgress(): Promise<void> {}

/**
 * Summarize, ask System One, judge — durably, and in that order.
 *
 * The one rule worth stating twice is that the judge is never asked without
 * priors. System One still cannot fail this workflow: a packet that reaches here
 * is already stored and already acknowledged, so a rejected jev step is caught
 * and normalised rather than thrown. What it now ends is the evaluation. System
 * Two reasons from System One's distributions, so a run whose first model never
 * answered stops at `jev` and returns no verdict instead of an ungrounded one.
 * The judge is the opposite case: a verdict is the thing this pipeline exists to
 * produce, so once its retries are spent the failure propagates and the run is
 * failed rather than recorded as an opinion nobody gave.
 *
 * Progress is reported after a step rather than before it, so a milestone is
 * always a claim about work that is durably done.
 */
export async function runEvaluate(
  step: EvaluateStep,
  payload: EvaluatePayload,
  deps: EvaluateDeps,
): Promise<EvaluateResult> {
  const packet = payload.packet;
  const packetId = packet.packet_id;
  const report = deps.onProgress ?? noProgress;

  const summary = await step.do("summarize", STEP_RETRIES.summarize, async () =>
    deps.summarize(packet),
  );
  await report({ packet_id: packetId, step: "summarize", stage: STEP_STAGES.summarize });

  let jev: JevResult;
  try {
    jev = await step.do("jev", STEP_RETRIES.jev, async () => {
      const result = await deps.callSystemOne(summary);
      // A failure the client has already judged hopeless resolves the step: it
      // is the answer, and retrying a missing API key twice more only delays
      // the judge by three seconds to reach the same conclusion.
      if (!result.ok && result.retryable) throw new JevStepFailure(result);
      return result;
    });
  } catch (error) {
    jev = toJevFailure(error);
  }
  await report({
    packet_id: packetId,
    step: "jev",
    stage: STEP_STAGES.jev,
    jev_status: jevStateStatus(jev),
  });

  // System Two is not asked without System One's answers. A verdict reached from
  // the summary alone is a second opinion with nothing to be second to, and the
  // packet is better left ungraded than graded on evidence the pipeline promises
  // to weigh and in this run never obtained.
  if (!jev.ok) return { packet_id: packetId, summary, jev, failed_at: "jev" };

  const verdict = await step.do("judge", STEP_RETRIES.judge, async () => deps.judge(summary, jev));
  await report({ packet_id: packetId, step: "judge", stage: STEP_STAGES.judge });

  return { packet_id: packetId, summary, jev, verdict };
}
