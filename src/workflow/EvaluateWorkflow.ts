import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";
import { callSystemOne } from "../jev/client";
import { judgeWithLlama } from "../llm/judge";
import { runEvaluate, type EvaluatePayload, type EvaluateResult } from "./evaluate";
import { summarizePacket } from "./summarize";

/**
 * The durable shell around the evaluation, and nothing more.
 *
 * Progress updates the BoardState chip via `applyBoardMilestone` (durable
 * step.do) so a retried judge does not replay earlier stage transitions, and
 * so the shared `board` instance the demo watches receives the same chips.
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
      onProgress: (milestone) =>
        step.do(`board-progress-${milestone.step}`, { retries: { limit: 0, delay: 0 } }, async () => {
          await this.agent.applyBoardMilestone(milestone);
        }),
    });

    await step.reportComplete(result);
    return result;
  }
}
