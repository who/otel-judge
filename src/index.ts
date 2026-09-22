import { handleRequest } from "./worker/router";

export { OtelJudgeAgent } from "./agent/OtelJudgeAgent";
export { EvaluateWorkflow } from "./workflow/EvaluateWorkflow";

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
