/**
 * Who is allowed to push telemetry at this judge.
 *
 * The producer is a service, not a person, and the body it sends is small, so
 * the credential is an HMAC-SHA256 of the raw body under a shared secret rather
 * than a bearer token. Signing binds the credential to the payload: a header
 * captured off one packet proves nothing about another, which a stolen bearer
 * token would. The secret arrives as a Wrangler secret and never leaves this
 * module — not into a log line, not into an error body, not into a header.
 */

/** Where the producer puts its lowercase hex digest. Part of the wire contract. */
export const FIREHOSE_SIGNATURE_HEADER = "x-firehose-signature";

/**
 * What verification reads from the environment.
 *
 * Structural rather than the generated `Env`, because the secret is a Wrangler
 * secret and therefore absent from the typed bindings, and because a test wants
 * to hand this an object literal instead of standing up a deployment.
 */
export interface FirehoseEnv {
  readonly FIREHOSE_SECRET?: string;
}

/**
 * The three things a request can be, and none of them is an exception.
 *
 * `disabled` is kept apart from `rejected` because they are different operator
 * facts: one says this deployment was never given a secret, the other says a
 * caller failed to prove it has one. Collapsing them would hide a
 * misconfiguration behind what looks like an attack.
 */
export type FirehoseVerdict = "verified" | "rejected" | "disabled";

const encoder = new TextEncoder();

/**
 * The digest a producer is expected to send for this body.
 *
 * Exported because the signature is a two-sided contract: the same function
 * that verifies is the one a test — or a producer written against this
 * repository — signs with, so the two halves cannot drift apart.
 */
export async function signFirehoseBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two hex digests without letting the clock say how much of one matched.
 *
 * `timingSafeEqual` throws on unequal lengths, and a length is not a secret, so
 * the length check comes first and answers false rather than turning a wrongly
 * sized header into an exception that would surface as a 500.
 */
function digestsMatch(offered: string, expected: string): boolean {
  const left = encoder.encode(offered);
  const right = encoder.encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * Decide whether this body was signed by someone holding the firehose secret.
 *
 * Without a secret the answer is `disabled` and never `verified`: an ingest
 * route on a public URL that falls open when it is unconfigured is worse than
 * one that refuses traffic, because the failure is silent and the traffic is
 * whatever the internet sends. The digest is computed over the bytes as they
 * arrived, not over a re-serialisation of the parsed packet, so a producer that
 * signs a prettified copy of what it sends is told no.
 */
export async function verifyFirehoseRequest(
  rawBody: string,
  request: Request,
  env: FirehoseEnv,
): Promise<FirehoseVerdict> {
  const secret = env.FIREHOSE_SECRET?.trim();
  if (!secret) return "disabled";

  const offered = request.headers.get(FIREHOSE_SIGNATURE_HEADER);
  if (!offered) return "rejected";

  // Case folding an attacker-supplied header depends on nothing secret, so it
  // costs no timing and spares a producer one pointless integration round trip.
  const expected = await signFirehoseBody(secret, rawBody);
  return digestsMatch(offered.trim().toLowerCase(), expected) ? "verified" : "rejected";
}
