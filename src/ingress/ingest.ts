import { agentNameForPacket } from "../agent/identity";
import { validatePacket } from "../packet/validate";
import { jsonError } from "../worker/errors";
import { enforceBodyLimit } from "../worker/limits";
import { forwardToAgent } from "./forward";
import { FIREHOSE_SIGNATURE_HEADER, verifyFirehoseRequest, type FirehoseEnv } from "./verify";

/** The stable path a producer codes against; changing it is a two-repository change. */
export const INGEST_PATH = "/ingest";

/** The door's bindings plus the secret that switches ingress on. */
export type IngestEnv = Env & FirehoseEnv;

/**
 * Bound the body and prove who sent it, before anything looks inside it.
 *
 * The order of these two steps is the security property, not an implementation
 * detail: the body is bounded before it is held and verified before it is
 * parsed, so an unauthenticated caller cannot make this Worker spend
 * `JSON.parse` on bytes of its choosing and an oversize body is dropped before
 * any cryptography runs on it. Every dialect of the front door shares this
 * function rather than its own copy, because a second copy is free to put the
 * steps in the other order.
 *
 * The raw text is returned on success — the exact bytes that were signed, which
 * is what a signature is about — and the refusal is returned as the response
 * the caller should send, so no dialect invents its own wording for 401 or 503.
 */
export async function readVerifiedBody(
  request: Request,
  env: IngestEnv,
): Promise<string | Response> {
  const body = await enforceBodyLimit(request);
  if (body instanceof Response) return body;

  const verdict = await verifyFirehoseRequest(body, request, env);
  if (verdict === "disabled") {
    return jsonError(
      "ingress_disabled",
      "This deployment has no firehose secret configured, so it accepts no packets",
      503,
    );
  }
  if (verdict === "rejected") {
    // The message names the header and nothing else. Telling a caller how its
    // digest differed from the expected one is telling it how to search.
    return jsonError(
      "invalid_signature",
      `The request carried no valid ${FIREHOSE_SIGNATURE_HEADER} for this body`,
      401,
    );
  }

  return body;
}

/**
 * The verified front door for packets.
 *
 * Verified before parsed, parsed before routed. Identity comes from
 * `agentNameForPacket`, the function the Agent itself uses. There is one
 * derivation in the codebase on purpose: a second one here would be free to
 * disagree, and the packets it misrouted would sit in an instance nothing ever
 * addresses again.
 */
export async function handleIngest(request: Request, env: IngestEnv): Promise<Response> {
  const body = await readVerifiedBody(request, env);
  if (body instanceof Response) return body;

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    // Fixed wording rather than the parser's, which quotes the offending body
    // back at whoever reads the response.
    return jsonError(
      "malformed_payload",
      "packet: expected a JSON object, received a body that is not valid JSON",
      400,
    );
  }

  const result = validatePacket(payload);
  // The whole error list, matching what the Agent answers on the same failure,
  // so a producer sees one contract regardless of which layer turned it away.
  if (!result.ok) return Response.json({ error: result.code, errors: result.errors }, { status: 400 });

  return forwardToAgent(env, agentNameForPacket(result.packet), body);
}
