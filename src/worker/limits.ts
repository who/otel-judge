import { jsonError } from "./errors";

/** 128 KiB. A packet larger than this is a producer bug or an attack, never real telemetry. */
export const MAX_BODY_BYTES = 131072;

function tooLarge(): Response {
  return jsonError(
    "packet_too_large",
    `Request body exceeds ${MAX_BODY_BYTES} bytes`,
    413,
  );
}

/**
 * Buffer a request body under a hard cap, returning the decoded text or a 413.
 *
 * Content-length is only a hint: a hostile producer can omit it or lie, so the
 * stream is counted as it arrives and cancelled the moment it passes the cap.
 * Nothing here parses the body, so an oversize payload never reaches JSON.parse.
 */
export async function enforceBodyLimit(request: Request): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }

  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffered);
}
