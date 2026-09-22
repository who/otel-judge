/** Used when DEMO_ORIGINS is absent or empty, so a misconfigured deploy still serves the demo. */
const DEFAULT_ORIGINS = ["https://who.github.io"];

/** Parse the comma-separated DEMO_ORIGINS var, falling back to the documented default. */
export function allowedOrigins(env: Env): string[] {
  const configured = (env.DEMO_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return configured.length > 0 ? configured : DEFAULT_ORIGINS;
}

/**
 * Headers that let an allowlisted browser origin read the response.
 *
 * A request from an unlisted origin is still served — non-browser producers are
 * legitimate and send no Origin at all — it simply gets no allow header, which
 * is what makes the browser refuse to expose the body. Credentials are allowed
 * because WebSocket upgrades to the Agent travel through this same door, so the
 * origin is echoed exactly rather than wildcarded.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  // Vary is unconditional: a cache must not hand an unlisted origin's bare
  // response to an allowlisted one, or the reverse.
  const headers: Record<string, string> = { vary: "Origin" };
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return headers;

  headers["access-control-allow-origin"] = origin;
  headers["access-control-allow-credentials"] = "true";
  headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
  headers["access-control-allow-headers"] = "content-type, authorization";
  headers["access-control-max-age"] = "86400";
  return headers;
}

/** Preflight is answered bare; the caller attaches whatever CORS headers the origin earned. */
export function handlePreflight(): Response {
  return new Response(null, { status: 204 });
}
