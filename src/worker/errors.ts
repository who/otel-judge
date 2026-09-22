/**
 * Every channel that consumes this Worker is programmatic, so errors are JSON
 * with a stable machine-readable code rather than an HTML body.
 */
export function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
