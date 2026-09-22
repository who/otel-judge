import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { countPackets, getPacketStatus, sqlTag } from "../src/agent/store";
import { MAX_BODY_BYTES } from "../src/packet/limits";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";

/**
 * Every case reaches the Agent directly rather than through the Worker door.
 *
 * That is the point of the file: the door already caps bodies and routes names,
 * so testing through it would prove the door works and leave the Agent's own
 * guards unexercised. A packet arriving from a chat channel or a replay gets
 * exactly this treatment, and `runInDurableObject` is the closest a test can
 * stand to it.
 *
 * `onStart` is called by hand because reaching an instance directly skips the
 * lifecycle that would have created the tables on a first real request.
 */
function withAgent<T>(
  name: string,
  body: (instance: OtelJudgeAgent) => T | Promise<T>,
): Promise<T> {
  const stub = env.OTEL_JUDGE_AGENT.get(env.OTEL_JUDGE_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return body(instance);
  });
}

function post(body: unknown): Request {
  return new Request("https://judge.test/agents/otel-judge-agent/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function packet(overrides: Partial<Packet> = {}): Packet {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: "pkt-1",
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

it("accepts a new packet with 202, one stored row, and a published snapshot", async () => {
  await withAgent("accept-new", async (instance) => {
    const response = await instance.onRequest(post(packet()));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      packet_id: "pkt-1",
      agent: "prod:checkout",
      stage: "accepted",
    });

    const sql = sqlTag(instance);
    expect(countPackets(sql)).toBe(1);
    expect(getPacketStatus(sql, "pkt-1")).toBe("accepted");

    expect(instance.state.stage).toBe("accepted");
    expect(instance.state.packets_seen).toBe(1);
    expect(instance.state.last_packet_id).toBe("pkt-1");
    expect(instance.state.agent_name).toBe("prod:checkout");
    expect(instance.state.updated_at).not.toBe("1970-01-01T00:00:00.000Z");
  });
});

it("answers a repeated packet id as a duplicate and leaves the row count alone", async () => {
  await withAgent("accept-repeat", async (instance) => {
    expect((await instance.onRequest(post(packet()))).status).toBe(202);
    const published = instance.state;

    // Different content under the same id: producers own their idempotency
    // keys, so the id alone decides, and the second body is never stored.
    const response = await instance.onRequest(
      post(packet({ alert_labels: ["something-else"] })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: false,
      duplicate: true,
      packet_id: "pkt-1",
      status: "accepted",
    });

    expect(countPackets(sqlTag(instance))).toBe(1);
    expect(instance.state.packets_seen).toBe(published.packets_seen);
    expect(instance.state.updated_at).toBe(published.updated_at);
  });
});

it("rejects an invalid packet with 400 and every field error in one reply", async () => {
  await withAgent("accept-invalid", async (instance) => {
    const response = await instance.onRequest(
      post({ ...packet(), env: "production", exemplar_trace_ids: "not-an-array" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; errors: string[] };
    expect(body.error).toBe("invalid_packet");
    expect(body.errors.some((error) => error.startsWith("env:"))).toBe(true);
    expect(body.errors.some((error) => error.startsWith("exemplar_trace_ids:"))).toBe(true);

    expect(countPackets(sqlTag(instance))).toBe(0);
    expect(instance.state.stage).toBe("idle");
  });
});

it("rejects a body that is not a JSON object with 400 rather than a thrown parse error", async () => {
  await withAgent("accept-unparseable", async (instance) => {
    const broken = await instance.onRequest(post("{not json"));
    expect(broken.status).toBe(400);
    const brokenBody = (await broken.json()) as { error: string; errors: string[] };
    expect(brokenBody.error).toBe("malformed_payload");
    expect(brokenBody.errors.length).toBeGreaterThan(0);

    // Valid JSON, wrong kind of thing: the validator answers, not the parser.
    const array = await instance.onRequest(post([]));
    expect(array.status).toBe(400);
    expect((await array.json()) as { error: string }).toMatchObject({
      error: "malformed_payload",
    });

    expect(countPackets(sqlTag(instance))).toBe(0);
  });
});

it("rejects an oversize body with 413 before anything tries to parse it", async () => {
  await withAgent("accept-oversize", async (instance) => {
    // Not JSON either: a 400 here would mean the size check ran too late.
    const response = await instance.onRequest(post("x".repeat(MAX_BODY_BYTES + 1)));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "packet_too_large",
      message: expect.any(String),
    });
    expect(countPackets(sqlTag(instance))).toBe(0);
  });
});
