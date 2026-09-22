import { jevApiKey, MISSING_API_KEY, type JevKeyEnv } from "./degraded";
import { parseSystemOneResponse } from "./parse";
import {
  buildSystemOneRequest,
  jevModel,
  SystemOneRequestError,
  type JevEnv,
  type SystemOneRequestBody,
  type SystemOneState,
} from "./request";
import type { JevFailure, JevResult } from "./types";

/**
 * The one place the judge talks to System One.
 *
 * Plain `fetch` and nothing else: Workers has no Node HTTP stack, so an SDK
 * would be dead weight at best. The whole of the transport policy is here — one
 * attempt, one timeout, one mapping from what came back onto a result the caller
 * can branch on — and none of it throws, because an unreachable model is an
 * ordinary outcome in this system rather than an exception to it.
 */

/** The documented System One endpoint; the only URL this module knows. */
export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * How long one attempt is given.
 *
 * Ten seconds is long enough for a batched answer over five questions and short
 * enough that a stalled call still leaves room inside a workflow step for the
 * retry that owns it. A timeout is retryable: nothing about the request has been
 * shown to be wrong.
 */
export const JEV_TIMEOUT_MS = 10_000;

/**
 * What the client reads from the environment.
 *
 * Structural, like the builder's env, so a test can call this with an object
 * literal. The key is a Wrangler secret and stays in this function: it is never
 * logged, never returned in a failure reason, and never stored.
 */
export interface JevClientEnv extends JevEnv, JevKeyEnv {}

function failure(retryable: boolean, reason: string, status?: number): JevFailure {
  return status === undefined ? { ok: false, retryable, reason } : { ok: false, retryable, reason, status };
}

/**
 * Say what went wrong on the wire, keeping a timeout distinct from everything else.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`, and an abort from
 * anywhere else arrives as `AbortError`; both mean the attempt ran out of time
 * rather than that the network refused it. The distinction is worth the two
 * lines because it is the difference between "System One is slow" and "System
 * One is unreachable" when someone is reading a workflow history later.
 */
function describeTransportError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `timed out after ${JEV_TIMEOUT_MS}ms`;
  return `network error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Ask System One every question once, and report what came of it.
 *
 * Exactly one attempt is made. Retrying belongs to the workflow step that calls
 * this, where an attempt is durable, visible in the history, and counted once;
 * a loop in here would multiply against that one invisibly and turn a bad
 * minute for the API into a much worse one. Everything this function knows about
 * whether a second attempt could help is in `retryable`.
 *
 * Nothing about the response is logged. The answers are customer signal detail
 * and their home is SQL, not a log line somebody greps months later.
 */
export async function callSystemOne(env: JevClientEnv, state: SystemOneState): Promise<JevResult> {
  // Before anything is built or sent: with no key there is nothing to try, and
  // an attempt would spend a whole timeout learning what the environment could
  // have said immediately. Non-retryable because no number of attempts
  // configures a secret. One log line, naming the token and nothing else, so a
  // deployment missing its key is visible without a credential ever reaching a
  // log sink.
  const key = jevApiKey(env);
  if (key === "") {
    console.warn(`System One was not called: ${MISSING_API_KEY}`);
    return failure(false, MISSING_API_KEY);
  }

  let body: SystemOneRequestBody;
  try {
    body = buildSystemOneRequest(state, env);
  } catch (error) {
    // A body this side of the wire refused to build is a bug here, not a fault
    // of the API, so no amount of retrying reaches a different outcome.
    const detail = error instanceof SystemOneRequestError ? error.code : "unknown";
    return failure(false, `request could not be built: ${detail}`);
  }

  // The key is known to be present and trimmed by the time it gets here, so
  // this header can never read "Bearer undefined" or carry the stray spaces a
  // copy-pasted secret arrives with — the request either goes out credentialed
  // or it was never built.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(SYSTEM_ONE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    return failure(true, describeTransportError(error));
  }

  if (!response.ok) {
    // 429 and 5xx are the API asking for time; every other 4xx is the API
    // saying this request will never be accepted as sent.
    const retryable = response.status === 429 || response.status >= 500;
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 800);
    } catch {
      detail = "(response body unreadable)";
    }
    // Debug aid for local triangle: status + truncated body, never the key.
    // Request shape only ? model name, question keys, state keys ? no secrets.
    console.error("[jev] System One rejected request", {
      status: response.status,
      retryable,
      url: SYSTEM_ONE_URL,
      model: body.model,
      questionKeys: Object.keys(body.questions),
      stateKeys: Object.keys(body.state),
      responseBody: detail,
    });
    const reason =
      detail === ""
        ? `System One answered ${response.status}`
        : `System One answered ${response.status}: ${detail.slice(0, 200)}`;
    return failure(retryable, reason, response.status);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The status line arrived and the body did not, which is a connection that
    // died mid-read rather than a response that was wrong.
    return failure(true, describeTransportError(error), response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // An HTML error page or an empty body from a proxy lands here, and it lands
    // as a failure rather than as a thrown SyntaxError in the caller.
    return failure(false, "response body was not JSON", response.status);
  }

  const parsed = parseSystemOneResponse(payload);
  if (!parsed.ok) {
    // A schema mismatch is not a bad minute, so it is not retryable: the same
    // request would produce the same unusable body.
    console.error("[jev] System One 2xx body failed parse", {
      status: response.status,
      reason: parsed.reason,
      bodyPreview: text.slice(0, 800),
    });
    return failure(false, `malformed response: ${parsed.reason}`, response.status);
  }

  return {
    ok: true,
    answers: parsed.answers,
    // The model the response names is the one that actually answered; the
    // requested model is only a fallback for an API that does not echo it.
    model: parsed.model ?? jevModel(env),
    latency_ms: Date.now() - startedAt,
  };
}
