import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { getPacketStatus, sqlTag } from "../src/agent/store";
import { handleIngest, type IngestEnv } from "../src/ingress/ingest";
import { FIREHOSE_SIGNATURE_HEADER, signFirehoseBody } from "../src/ingress/verify";
import { MAX_BODY_BYTES } from "../src/packet/limits";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";

/**
 * Ingress is exercised by calling the handler with an env of the test's own
 * making, because the thing under test is what the door does with a secret it
 * either has or has not been given, and a binding configured once for the whole
 * suite could only ever show one of those two worlds. The door's own dispatch
 * is proved separately through `SELF`, where the unconfigured answer is the
 * evidence that the route exists at all.
 */
const SECRET = "firehose-test-secret";

/** A deployment that was given its secret. */
const configured: IngestEnv = { ...env, FIREHOSE_SECRET: SECRET };

/** A deployment that was not, which is what a fresh `wrangler deploy` is. */
const unconfigured: IngestEnv = { ...env };

function ingest(body: string, signature?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers[FIREHOSE_SIGNATURE_HEADER] = signature;
  return new Request("https://judge.test/ingest", { method: "POST", headers, body });
}

/** Post a body under a signature that is correct for exactly those bytes. */
async function postSigned(body: string, target: IngestEnv = configured): Promise<Response> {
  return handleIngest(ingest(body, await signFirehoseBody(SECRET, body)), target);
}

function packet(overrides: Partial<Packet> = {}): Packet {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: "ingest-1",
    service: "checkout",
    env: "prod",
    window: { start: "2026-09-21T10:00:00Z", end: "2026-09-21T10:05:00Z" },
    signals: {
      error_rate: 0.22,
      error_rate_baseline: 0.01,
      p95_latency_ms: 940,
      p95_latency_baseline_ms: 210,
      request_rate_rps: 48,
      slo_burn_rate: 14.5,
    },
    top_spans: [{ name: "POST /checkout", count: 1200, error_count: 264, p95_ms: 940 }],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    alert_labels: ["burn-rate", "checkout"],
    ...overrides,
  };
}

/**
 * Read one named instance's own storage, which is the only proof of where a
 * packet landed. `onStart` is called by hand so that asking an instance no
 * packet ever reached answers "nothing here" instead of failing on a table that
 * was never created; a filtered test run is otherwise a different test.
 */
function storedStatus(agentName: string, packetId: string): Promise<string | null> {
  const namespace = env.OTEL_JUDGE_AGENT;
  const stub = namespace.get(namespace.idFromName(agentName));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return getPacketStatus(sqlTag(instance), packetId);
  });
}

describe("forwards a verified packet to the Agent that owns it", () => {
  it("reaches the instance named for the service and environment", async () => {
    const body = JSON.stringify(packet({ packet_id: "ingest-forwarded" }));

    const response = await postSigned(body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      packet_id: "ingest-forwarded",
      agent: "prod:checkout",
      stage: "accepted",
    });
    expect(await storedStatus("prod:checkout", "ingest-forwarded")).toBe("accepted");
  });

  it("splits a burst of two services across two instances", async () => {
    const checkout = JSON.stringify(packet({ packet_id: "ingest-burst-checkout" }));
    const payments = JSON.stringify(
      packet({ packet_id: "ingest-burst-payments", service: "payments" }),
    );

    await postSigned(checkout);
    await postSigned(payments);

    expect(await storedStatus("prod:checkout", "ingest-burst-checkout")).toBe("accepted");
    expect(await storedStatus("prod:payments", "ingest-burst-payments")).toBe("accepted");
    expect(await storedStatus("prod:checkout", "ingest-burst-payments")).toBeNull();
  });

  it("returns the Agent's duplicate answer unchanged rather than an envelope", async () => {
    const body = JSON.stringify(packet({ packet_id: "ingest-twice" }));

    await postSigned(body);
    const second = await postSigned(body);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      accepted: false,
      duplicate: true,
      packet_id: "ingest-twice",
      status: "accepted",
    });
  });
});

describe("signature verification runs before anything reads the body", () => {
  const body = JSON.stringify(packet({ packet_id: "ingest-unauthorized" }));

  it("refuses a digest computed under another secret", async () => {
    const response = await handleIngest(
      ingest(body, await signFirehoseBody("not-the-secret", body)),
      configured,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_signature",
      message: expect.any(String),
    });
    expect(await storedStatus("prod:checkout", "ingest-unauthorized")).toBeNull();
  });

  it("refuses a request that carries no header at all", async () => {
    const response = await handleIngest(ingest(body), configured);

    expect(response.status).toBe(401);
  });

  it("refuses a digest of the wrong length without throwing", async () => {
    const response = await handleIngest(ingest(body, "abc123"), configured);

    expect(response.status).toBe(401);
  });

  it("refuses an unparseable body with 401 rather than 400", async () => {
    const response = await handleIngest(ingest("{not json at all", "00".repeat(32)), configured);

    expect(response.status).toBe(401);
  });

  it("refuses a digest taken over a re-serialised copy of the body", async () => {
    const payload = packet({ packet_id: "ingest-reserialised" });
    const overSpaced = await signFirehoseBody(SECRET, JSON.stringify(payload, null, 2));

    const response = await handleIngest(ingest(JSON.stringify(payload), overSpaced), configured);

    expect(response.status).toBe(401);
  });

  it("says nothing about the secret while refusing", async () => {
    const response = await handleIngest(ingest(body, "00".repeat(32)), configured);

    expect(await response.text()).not.toContain(SECRET);
  });
});

describe("disabled ingress and bodies past the cap", () => {
  it("answers 503 when no secret is configured, even for a valid digest", async () => {
    const body = JSON.stringify(packet({ packet_id: "ingest-while-disabled" }));

    const response = await postSigned(body, unconfigured);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ingress_disabled",
      message: expect.any(String),
    });
    expect(await storedStatus("prod:checkout", "ingest-while-disabled")).toBeNull();
  });

  it("treats a whitespace-only secret as no secret", async () => {
    const response = await postSigned("{}", { ...env, FIREHOSE_SECRET: "   " });

    expect(response.status).toBe(503);
  });

  it("answers 413 for an oversize body before it verifies anything", async () => {
    const response = await handleIngest(ingest("x".repeat(MAX_BODY_BYTES + 1)), configured);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "packet_too_large",
      message: expect.any(String),
    });
  });

  it("is reachable at POST /ingest through the Worker door", async () => {
    const response = await SELF.fetch("https://judge.test/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ingress_disabled",
      message: expect.any(String),
    });
  });
});

describe("a signed body still has to be a packet", () => {
  it("answers 400 with every validator error for a signed non-packet", async () => {
    const response = await postSigned(JSON.stringify({ schema_version: PACKET_SCHEMA_VERSION }));

    expect(response.status).toBe(400);
    const failure = (await response.json()) as { error: string; errors: string[] };
    expect(failure.error).toBe("invalid_packet");
    expect(failure.errors.length).toBeGreaterThan(1);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const response = await postSigned("not json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "malformed_payload",
      message: expect.any(String),
    });
  });

  it("answers 400 for an empty body signed over the empty string", async () => {
    const response = await postSigned("");

    expect(response.status).toBe(400);
  });
});
