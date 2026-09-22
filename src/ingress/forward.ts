import { getAgentByName } from "agents";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";

/**
 * The URL the forwarded packet travels under.
 *
 * A Durable Object stub is addressed by id, so the host here is decoration and
 * only the path carries meaning; it is spelled the same as the public route so
 * that a request seen inside the Agent reads as the one the producer sent.
 */
const AGENT_INGEST_URL = "https://otel-judge.internal/ingest";

/** The one binding forwarding needs, named so a test can pass a bare object. */
export interface AgentForwardEnv {
  readonly OTEL_JUDGE_AGENT: DurableObjectNamespace<OtelJudgeAgent>;
}

/**
 * Hand the raw body to the Agent that owns this packet and return what it said.
 *
 * `getAgentByName` rather than a hand-built id: it is the same resolution the
 * SDK's own router performs, and it waits for the instance's startup to finish,
 * so the tables exist before the accept path touches them. The body is passed
 * through as the bytes that were signed — re-encoding a parsed packet here
 * would mean the Agent stores something no producer ever sent.
 *
 * The Agent's response is returned untouched, statuses and all. The door has no
 * opinion to add: whether this was a 202, a duplicate 200, or a 400 is the
 * Agent's decision, and wrapping it would give the producer two contracts to
 * learn where one will do.
 */
export async function forwardToAgent(
  env: AgentForwardEnv,
  agentName: string,
  rawBody: string,
): Promise<Response> {
  const agent = await getAgentByName<Env, OtelJudgeAgent>(env.OTEL_JUDGE_AGENT, agentName);
  return agent.fetch(AGENT_INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}
