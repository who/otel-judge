import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";

export class EvaluateWorkflow extends AgentWorkflow<OtelJudgeAgent> {
  async run(_event: AgentWorkflowEvent<unknown>, _step: AgentWorkflowStep): Promise<void> {
    throw new Error("Evaluation workflow is not implemented");
  }
}
