import { createExecutionContext, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { getPacketStatus, sqlTag } from "../src/agent/store";
import type { IngestEnv } from "../src/ingress/ingest";
import { AdapterError, OTLP_INGEST_PATH, otlpToPacket } from "../src/ingress/otlp";
import { FIREHOSE_SIGNATURE_HEADER, signFirehoseBody } from "../src/ingress/verify";
import type { Packet } from "../src/packet/types";
import { validatePacket } from "../src/packet/validate";
import { handleRequest } from "../src/worker/router";
import checkoutMetrics from "../fixtures/otlp/checkout-metrics.json";

/**
 * The adapter is exercised as a function and the route as a door, because they
 * answer different questions: whether an export becomes the right packet, and
 * whether a collector holding the secret can get one in. Every refusal case is
 * the recorded fixture with exactly one thing wrong with it, so what the test
 * proves is that the one defect is what was refused.
 */
const SECRET = "otlp-test-secret";

/** A deployment that was given its firehose secret; the OTLP route reuses the same one. */
const configured: IngestEnv = { ...env, FIREHOSE_SECRET: SECRET };

interface TestAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface TestPoint {
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  count?: string;
  sum?: number;
  bucketCounts?: string[];
  explicitBounds?: number[];
  attributes?: TestAttribute[];
}

interface TestMetric {
  name: string;
  unit?: string;
  sum?: { aggregationTemporality: number; isMonotonic?: boolean; dataPoints: TestPoint[] };
  histogram?: { aggregationTemporality: number; dataPoints: TestPoint[] };
}

interface TestResource {
  resource: { attributes: TestAttribute[] };
  scopeMetrics: { metrics: TestMetric[] }[];
}

interface TestExport {
  resourceMetrics: TestResource[];
  baselines?: Record<string, unknown>;
}

/**
 * The fixture as a tree a test may edit.
 *
 * Cloned per call: a static import is one object for the whole run, so a test
 * that broke the environment attribute in place would be handing every later
 * test a different export than the one on disk.
 */
function exported(): TestExport {
  return structuredClone(checkoutMetrics) as unknown as TestExport;
}

function metricNamed(body: TestExport, name: string): TestMetric {
  const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((entry) => entry.name === name);
  if (metric === undefined) throw new Error(`the fixture no longer carries ${name}`);
  return metric;
}

function attribute(body: TestExport, key: string): TestAttribute {
  const found = body.resourceMetrics[0]?.resource.attributes.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`the fixture no longer carries ${key}`);
  return found;
}

/** Translate, insisting on the success branch, so a test reads as what it asserts about. */
async function translated(body: unknown): Promise<Packet> {
  const result = await otlpToPacket(body);
  if (result instanceof AdapterError) throw new Error(`translation failed: ${result.code} ${result.message}`);
  return result;
}

/** Translate, insisting on the refusal branch, and hand back the reason it gave. */
async function refused(body: unknown): Promise<AdapterError> {
  const result = await otlpToPacket(body);
  if (!(result instanceof AdapterError)) throw new Error(`translation succeeded: ${result.packet_id}`);
  return result;
}

/** Post an export to the door under a signature correct for exactly those bytes. */
async function postExport(body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  const request = new Request(`https://judge.test${OTLP_INGEST_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [FIREHOSE_SIGNATURE_HEADER]: await signFirehoseBody(SECRET, raw),
    },
    body: raw,
  });
  const ctx = createExecutionContext();
  const response = await handleRequest(request, configured, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Where a packet landed, read from the named instance's own storage. */
function storedStatus(agentName: string, packetId: string): Promise<string | null> {
  const namespace = env.OTEL_JUDGE_AGENT;
  const stub = namespace.get(namespace.idFromName(agentName));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return getPacketStatus(sqlTag(instance), packetId);
  });
}

describe("translates a recorded OTLP export into a normalized packet", () => {
  it("produces a packet the validator accepts unchanged", async () => {
    const packet = await translated(exported());

    // Through the wire format first: what the door forwards is the serialised
    // copy, so that is the thing that has to satisfy the contract.
    const result = validatePacket(JSON.parse(JSON.stringify(packet)) as unknown);
    if (!result.ok) throw new Error(`the translated packet was refused: ${result.errors.join(" | ")}`);

    expect(result.packet.service).toBe("checkout");
    expect(result.packet.env).toBe("prod");
    expect(result.packet.window).toEqual({
      start: "2026-09-21T10:00:00.000Z",
      end: "2026-09-21T10:05:00.000Z",
    });
  });

  it("derives the signals from the counter and the histogram", async () => {
    const packet = await translated(exported());

    // 1820 of 10920 requests carry error.type, over a five-minute window.
    expect(packet.signals.error_rate).toBeCloseTo(0.1667, 4);
    expect(packet.signals.request_rate_rps).toBeCloseTo(36.4, 4);
    // The 95th observation of 10920 falls in the bucket bounded at 1000ms.
    expect(packet.signals.p95_latency_ms).toBe(1000);
    // Baselines are the producer's numbers, copied rather than computed.
    expect(packet.signals.error_rate_baseline).toBe(0.004);
    expect(packet.signals.p95_latency_baseline_ms).toBe(240);
    expect(packet.signals.slo_burn_rate).toBe(8.7);
    // A metrics export carries no spans, exemplars or alert routing.
    expect(packet.top_spans).toEqual([]);
    expect(packet.exemplar_trace_ids).toEqual([]);
    expect(packet.alert_labels).toEqual([]);
  });

  it("scales a histogram reported in seconds into milliseconds", async () => {
    const body = exported();
    const duration = metricNamed(body, "http.server.request.duration");
    duration.unit = "s";
    const point = duration.histogram?.dataPoints[0];
    if (point === undefined) throw new Error("the fixture no longer carries a duration data point");
    point.explicitBounds = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5];

    const packet = await translated(body);

    expect(packet.signals.p95_latency_ms).toBe(1000);
  });

  it("truncates nanosecond timestamps to whole milliseconds", async () => {
    const body = exported();
    for (const metric of body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []) {
      for (const point of metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []) {
        point.startTimeUnixNano = "1789984800123456789";
        point.timeUnixNano = "1789985100987654321";
      }
    }

    const packet = await translated(body);

    expect(packet.window.start).toBe("2026-09-21T10:00:00.123Z");
    expect(packet.window.end).toBe("2026-09-21T10:05:00.987Z");
  });

  it("reports no burn when the producer publishes no error budget", async () => {
    const body = exported();
    delete body.baselines?.slo_burn_rate;

    const packet = await translated(body);

    expect(packet.signals.slo_burn_rate).toBe(0);
  });

  it("reaches the Agent that owns the service through the signed OTLP route", async () => {
    const expected = await translated(exported());

    const response = await postExport(exported());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      packet_id: expected.packet_id,
      agent: "prod:checkout",
      stage: "accepted",
    });
    expect(await storedStatus("prod:checkout", expected.packet_id)).toBe("accepted");
  });

  it("is claimed by the door, which answers an unsigned export without an Agent", async () => {
    const response = await SELF.fetch(`https://judge.test${OTLP_INGEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // No secret is configured for the deployed door, so ingress is off; a 404
    // here would mean the route was never claimed at all.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ingress_disabled", message: expect.any(String) });
  });
});

describe("refuses a translation it cannot complete", () => {
  it("names the missing baselines block rather than inventing normal", async () => {
    const body = exported();
    delete body.baselines;

    const error = await refused(body);

    expect(error.code).toBe("otlp_missing_baselines");
    expect(error.message).toContain("baselines");
  });

  it("names the one baseline field that is absent", async () => {
    const body = exported();
    delete body.baselines?.p95_latency_ms;

    const error = await refused(body);

    expect(error.code).toBe("otlp_missing_baselines");
    expect(error.message).toContain("baselines.p95_latency_ms");
  });

  it("refuses an environment it cannot map onto the contract's three", async () => {
    const body = exported();
    attribute(body, "deployment.environment").value.stringValue = "canary-eu";

    const error = await refused(body);

    expect(error.code).toBe("otlp_unknown_environment");
    expect(error.message).toContain("canary-eu");
  });

  it("refuses an export with no service name to file it under", async () => {
    const body = exported();
    const resource = body.resourceMetrics[0];
    if (resource === undefined) throw new Error("the fixture no longer carries a resource");
    resource.resource.attributes = resource.resource.attributes.filter(
      (entry) => entry.key !== "service.name",
    );

    const error = await refused(body);

    expect(error.code).toBe("otlp_missing_service_name");
    expect(error.message).toContain("service.name");
  });

  it("refuses an export describing two services instead of using the first", async () => {
    const body = exported();
    const second = structuredClone(body.resourceMetrics[0]) as TestResource;
    const name = second.resource.attributes.find((entry) => entry.key === "service.name");
    if (name === undefined) throw new Error("the fixture no longer carries a service name");
    name.value.stringValue = "payments";
    body.resourceMetrics.push(second);

    const error = await refused(body);

    expect(error.code).toBe("otlp_multiple_services");
    expect(error.message).toContain("payments");
  });

  it("refuses a cumulative counter, whose meaning is not a window", async () => {
    const body = exported();
    const counter = metricNamed(body, "http.server.request.count");
    if (counter.sum === undefined) throw new Error("the fixture no longer carries a counter");
    counter.sum.aggregationTemporality = 2;

    const error = await refused(body);

    expect(error.code).toBe("otlp_unsupported_temporality");
  });

  it("refuses a histogram with no recorded durations rather than reporting zero", async () => {
    const body = exported();
    const point = metricNamed(body, "http.server.request.duration").histogram?.dataPoints[0];
    if (point === undefined) throw new Error("the fixture no longer carries a duration data point");
    point.count = "0";
    point.bucketCounts = ["0", "0", "0", "0", "0", "0", "0", "0"];

    const error = await refused(body);

    expect(error.code).toBe("otlp_empty_histogram");
  });

  it("refuses a duration histogram in a unit it cannot convert", async () => {
    const body = exported();
    metricNamed(body, "http.server.request.duration").unit = "ns";

    const error = await refused(body);

    expect(error.code).toBe("otlp_unsupported_unit");
  });

  it("refuses a non-finite baseline through the packet validator itself", async () => {
    const body = exported();
    if (body.baselines === undefined) throw new Error("the fixture no longer carries baselines");
    body.baselines.error_rate = Number.NaN;

    const error = await refused(body);

    expect(error.code).toBe("otlp_invalid_packet");
    expect(error.message).toContain("signals.error_rate_baseline");
  });

  it("answers the route with the adapter's reason and forwards nothing", async () => {
    const body = exported();
    delete body.baselines;

    const response = await postExport(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "otlp_missing_baselines",
      message: expect.any(String),
    });
    const wouldHaveBeen = await translated(exported());
    expect(await storedStatus("prod:payments", wouldHaveBeen.packet_id)).toBeNull();
  });

  it("refuses a signed body that is not JSON at all", async () => {
    const raw = "resourceMetrics=none";
    const request = new Request(`https://judge.test${OTLP_INGEST_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [FIREHOSE_SIGNATURE_HEADER]: await signFirehoseBody(SECRET, raw),
      },
      body: raw,
    });
    const ctx = createExecutionContext();

    const response = await handleRequest(request, configured, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "malformed_payload",
      message: expect.any(String),
    });
  });

  it("refuses an unsigned export before it reads a field of it", async () => {
    const request = new Request(`https://judge.test${OTLP_INGEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exported()),
    });
    const ctx = createExecutionContext();

    const response = await handleRequest(request, configured, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});

describe("derives a deterministic packet id", () => {
  it("gives two translations of one export the same id", async () => {
    const first = await translated(exported());
    const second = await translated(exported());

    expect(second.packet_id).toBe(first.packet_id);
    expect(first.packet_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives a different window a different id", async () => {
    const body = exported();
    for (const metric of body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []) {
      for (const point of metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []) {
        point.startTimeUnixNano = "1789985100000000000";
        point.timeUnixNano = "1789985400000000000";
      }
    }

    const moved = await translated(body);

    expect(moved.packet_id).not.toBe((await translated(exported())).packet_id);
  });
});

describe("keeps the Agent unaware that the adapter exists", () => {
  /**
   * Read as text rather than imported: the claim is about the import graph, and
   * importing the modules to inspect them would only prove they load.
   */
  const agentSources = import.meta.glob("../src/{agent,workflow}/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("has no module under the Agent or workflow folders importing it", () => {
    expect(Object.keys(agentSources).length).toBeGreaterThan(0);
    for (const [file, source] of Object.entries(agentSources)) {
      expect(`${file}: ${source.includes("ingress/otlp")}`).toBe(`${file}: false`);
    }
  });
});
