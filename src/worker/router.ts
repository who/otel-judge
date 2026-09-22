import { routeAgentRequest } from "agents";
import { handleIngest, INGEST_PATH } from "../ingress/ingest";
import { handleOtlpIngest, OTLP_INGEST_PATH } from "../ingress/otlp";
import { corsHeaders, handlePreflight } from "./cors";
import { jsonError } from "./errors";
import { enforceBodyLimit } from "./limits";

/** Reported by /health so a demo or uptime check can tell which door it reached. */
const SERVICE_VERSION = "0.1.0";

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) merged.headers.set(name, value);
  return merged;
}

/**
 * Readiness without waking an Agent: binding presence is visible on env, so a
 * health probe costs no Durable Object start and no storage read.
 */
function health(env: Env): Response {
  return Response.json({
    ok: true,
    service: "otel-judge",
    version: SERVICE_VERSION,
    bindings: {
      ai: Boolean(env.AI),
      agent: Boolean(env.OTEL_JUDGE_AGENT),
      workflow: Boolean(env.EVALUATE_WORKFLOW),
    },
  });
}

/**
 * The Worker door: CORS, health, signed ingress, limits, then the SDK router.
 *
 * Everything unclaimed here is offered to `routeAgentRequest`, which owns
 * identity routing for `/agents/:binding/:name`; deriving Durable Object ids
 * here would split the Agent namespace against that. A null from it means "no
 * match", not a failure, and becomes a JSON 404.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") return withHeaders(handlePreflight(), cors);

  const url = new URL(request.url);
  if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return withHeaders(health(env), cors);
  }

  // Claimed before the shared limit runs, because ingress buffers the body
  // itself: it needs the exact bytes the producer signed, and the generic path
  // below rebuilds the request around a decoded copy for the SDK router.
  if (url.pathname === INGEST_PATH && request.method === "POST") {
    return withHeaders(await handleIngest(request, env), cors);
  }

  // The OTLP dialect of the same door, kept behind its own path so that the
  // normalized contract stays the thing the Agent is reached through. Deleting
  // this branch and the module it calls removes collector support and nothing
  // else, which is the portability claim stated as code.
  if (url.pathname === OTLP_INGEST_PATH && request.method === "POST") {
    return withHeaders(await handleOtlpIngest(request, env), cors);
  }

  // A WebSocket upgrade carries no body to buffer and must reach the Agent
  // with its handshake intact, so it bypasses the limit entirely.
  const upgrading = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  let forwarded = request;
  if (!upgrading && request.body) {
    const body = await enforceBodyLimit(request);
    if (body instanceof Response) return withHeaders(body, cors);
    forwarded = new Request(request, { body });
  }

  const routed = await routeAgentRequest(forwarded, env);
  if (routed) return withHeaders(routed, cors);

  return withHeaders(jsonError("not_found", `No route for ${request.method} ${url.pathname}`, 404), cors);
}
