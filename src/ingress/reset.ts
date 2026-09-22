import { getAgentByName } from "agents";
import { BOARD_INSTANCE_NAME, BOARD_RESET_HEADER } from "../agent/boardState";
import type { OtelJudgeAgent } from "../agent/OtelJudgeAgent";
import { jsonError } from "../worker/errors";
import type { AgentForwardEnv } from "./forward";

/** The stable path the demo's Reset button posts to; changing it is a two-repository change. */
export const RESET_PATH = "/reset";

/**
 * The URL the wipe travels under, addressed to a stub and so meaningful only in
 * its path — spelled like the public route so the request reads the same inside
 * the Agent as the one the browser sent.
 */
const AGENT_RESET_URL = "https://otel-judge.internal/reset";

/** The value the gate has to hold; anything else, including absence, is off. */
const ENABLED = "1";

/** Forwarding's one binding, plus the var that has to be set for reset to exist at all. */
export interface ResetEnv extends AgentForwardEnv {
  readonly ALLOW_BOARD_RESET?: string;
}

/**
 * Empty the shared board, when this deployment is one that allows it.
 *
 * Reset is destructive and unauthenticated — the demo's Reset button carries no
 * secret, unlike the firehose — so the only thing standing between a public URL
 * and a wiped board is that a deployment opted in by setting the var. The gate
 * is therefore checked before the Agent is so much as addressed: a refusal must
 * not wake an instance, let alone reach one that could clear a table.
 *
 * Only the `board` instance is wiped. Per-service Agents keep their history,
 * which is the point of the split: the board is the demo's window and clearing
 * it is a display decision, not a decision to destroy what was judged.
 */
export async function handleReset(env: ResetEnv): Promise<Response> {
  if (env.ALLOW_BOARD_RESET !== ENABLED) {
    return jsonError(
      "reset_disabled",
      "This deployment does not allow the board to be cleared",
      403,
    );
  }

  let response: Response;
  try {
    const board = await getAgentByName<Env, OtelJudgeAgent>(
      env.OTEL_JUDGE_AGENT,
      BOARD_INSTANCE_NAME,
    );
    response = await board.fetch(AGENT_RESET_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [BOARD_RESET_HEADER]: ENABLED },
      body: "{}",
    });
  } catch {
    return jsonError("reset_failed", "The board could not be reached; retry the reset", 502);
  }

  // The Agent clears its tables before it publishes, so a failure there left
  // the board exactly as it was and the caller is told so rather than being
  // handed a 200 it would read as an empty swimlane.
  if (!response.ok) {
    return jsonError("reset_failed", `The board refused the reset with ${response.status}`, 502);
  }

  return response;
}
