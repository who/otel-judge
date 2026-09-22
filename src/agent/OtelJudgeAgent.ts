import { Agent } from "agents";
import { INITIAL_STATE, type JudgeState } from "./state";

/**
 * Errors are JSON with a stable machine-readable code, never HTML: every caller
 * that reaches an Agent is a program. The shape matches the door's error body so
 * a client parses one thing regardless of which layer answered.
 */
function jsonError(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: code, message }, { status, headers });
}

/**
 * The judge itself: one durable instance per service and environment.
 *
 * This class deliberately depends on nothing but the Agents SDK and its own
 * folder. Whatever carries a packet here — an HTTP door, a chat channel, a
 * scheduled replay — plugs into the same surface, and none of them can be
 * reached in the other direction.
 */
export class OtelJudgeAgent extends Agent<Env, JudgeState> {
  /** Copied per instance so two Agents can never share one snapshot object. */
  override initialState: JudgeState = { ...INITIAL_STATE };

  /**
   * The one designated place startup work is invoked.
   *
   * Empty for now on purpose: otel-judge-9f0.2 creates the SQLite tables and
   * rehydrates `packets_seen` here, and having exactly one hook means a cold
   * start never races two initialisation paths against each other.
   */
  override onStart(): void {}

  /**
   * Answer direct HTTP with an explicit status instead of letting an
   * unsupported method fall through to an opaque SDK default.
   *
   * otel-judge-9f0.3 replaces the 501 with the real accept path; until then a
   * POST is told the truth rather than being silently dropped.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonError(
        "method_not_allowed",
        `${request.method} is not supported; POST a packet instead`,
        405,
        { allow: "POST" },
      );
    }

    return jsonError(
      "not_implemented",
      "Packet acceptance is not implemented yet",
      501,
    );
  }
}
