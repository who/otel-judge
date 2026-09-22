import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { enforceBodyLimit, MAX_BODY_BYTES } from "../src/worker/limits";

const DEMO_ORIGIN = "https://who.github.io";

it("answers health with binding readiness and no Agent wake-up", async () => {
  const response = await SELF.fetch("https://judge.test/health");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as {
    ok: boolean;
    service: string;
    version: string;
    bindings: Record<string, boolean>;
  };
  expect(body.ok).toBe(true);
  expect(body.service).toBe("otel-judge");
  expect(typeof body.version).toBe("string");
  expect(body.bindings).toEqual({ ai: true, agent: true, workflow: true });
});

describe("oversize bodies", () => {
  it("rejects a declared oversize body with a JSON 413", async () => {
    const response = await SELF.fetch("https://judge.test/agents/otel-judge-agent/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "packet_too_large",
      message: expect.any(String),
    });
  });

  it("rejects a streamed body that outgrows the cap without content-length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16384));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent <= MAX_BODY_BYTES; sent += chunk.byteLength) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const request = new Request("https://judge.test/ingest", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    expect(request.headers.get("content-length")).toBeNull();
    const outcome = await enforceBodyLimit(request);
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(413);
  });
});

describe("cors allowlist and unmatched routes", () => {
  it("returns 204 with allow headers for a preflight from the demo origin", async () => {
    const response = await SELF.fetch("https://judge.test/agents/otel-judge-agent/demo", {
      method: "OPTIONS",
      headers: { origin: DEMO_ORIGIN, "access-control-request-method": "POST" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DEMO_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("returns 204 without allow headers for a preflight from an unlisted origin", async () => {
    const response = await SELF.fetch("https://judge.test/agents/otel-judge-agent/demo", {
      method: "OPTIONS",
      headers: { origin: "https://attacker.test", "access-control-request-method": "POST" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns a JSON 404 for a path no route claims", async () => {
    const response = await SELF.fetch("https://judge.test/nowhere");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "not_found",
      message: expect.any(String),
    });
  });
});
