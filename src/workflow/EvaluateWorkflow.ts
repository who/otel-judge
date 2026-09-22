import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";
import { callSystemOne } from "../jev/client";
import { judgeWithLlama } from "../llm/judge";
import { runEvaluate, type EvaluatePayload, type EvaluateResult } from "./evaluate";
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
    return runEvaluate(step, event.payload, {
      summarize: summarizePacket,
      callSystemOne: (state) => callSystemOne(this.env, state),
      judge: (summary, jev) => judgeWithLlama(this.env, summary, jev),
    });
  }
}
