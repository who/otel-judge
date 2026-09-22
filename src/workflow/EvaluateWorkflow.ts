import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";
import { callSystemOne } from "../jev/client";
import { judgeWithLlama } from "../llm/judge";
import {
  milestoneState,
  runEvaluate,
  type EvaluatePayload,
  type EvaluateResult,
} from "./evaluate";
import { summarizePacket } from "./summarize";

/**
 * The durable shell around the evaluation, and nothing more.
 *
 * Every decision this workflow makes is in `runEvaluate`; what is left here is
 * the one thing that genuinely needs the runtime, which is knowing that the
 * environment holding the API key and the AI binding is `this.env`. Binding the
 * real implementations in a body this short is what keeps the branching logic
 * somewhere a fake step can drive it, and it is why a change to the pipeline is
 * a change to a tested function rather than to a class nothing can instantiate
 * without a workflow engine behind it.
 *
 * The returned result is the workflow's output as Workflows records it, so the
 * completion task can read one value out of a run instead of reassembling the
 * evaluation from three step outputs.
 */
export class EvaluateWorkflow extends AgentWorkflow<OtelJudgeAgent, EvaluatePayload> {
  async run(
    event: AgentWorkflowEvent<EvaluatePayload>,
    step: AgentWorkflowStep,
  ): Promise<EvaluateResult> {
    const result = await runEvaluate(step, event.payload, {
      summarize: summarizePacket,
      callSystemOne: (state) => callSystemOne(this.env, state),
      judge: (summary, jev) => judgeWithLlama(this.env, summary, jev),
      // Merged rather than set, and durable rather than broadcast from here:
      // the step wrapper records each merge as its own step, so a retried
      // `judge` does not replay the summarize milestone at a watching client.
      onProgress: (milestone) => step.mergeAgentState(milestoneState(milestone)),
    });

    // Completion is not announced for us. Returning a value tells Workflows the
    // run finished; it is this call that tells the Agent, and it has to happen
    // before the return or an evaluation would be recorded nowhere a later read
    // could find it. A failure needs no counterpart: the base class reports an
    // unhandled error to the Agent on its way out.
    await step.reportComplete(result);
    return result;
  }
}
