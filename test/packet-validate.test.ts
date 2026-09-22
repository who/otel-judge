import { describe, expect, it } from "vitest";
import { validatePacket } from "../src/packet/validate";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";

/** A well-formed payload, rebuilt per call so no test can leak state into another. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: "checkout:2026-01-01T00:00:00Z",
    service: "checkout",
    env: "prod",
    window: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:05:00Z" },
    signals: {
      error_rate: 0.12,
      error_rate_baseline: 0.01,
      p95_latency_ms: 840,
      p95_latency_baseline_ms: 210,
      request_rate_rps: 42.5,
      slo_burn_rate: 3.2,
    },
    top_spans: [{ name: "POST /checkout", count: 1200, error_count: 144, p95_ms: 840 }],
    exemplar_trace_ids: ["4BF92F3577B34DA6"],
    alert_labels: ["sev2", "checkout", "sev2"],
    ...overrides,
  };
}

function accepted(input: unknown): Packet {
  const result = validatePacket(input);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.errors.join(" | ")}`);
  return result.packet;
}

function rejected(input: unknown): string[] {
  const result = validatePacket(input);
  if (result.ok) throw new Error("expected rejection, got acceptance");
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe("a valid packet", () => {
  it("comes back normalised rather than merely approved", () => {
    const packet = accepted(payload({ service: "  checkout  " }));

    expect(packet.service).toBe("checkout");
    expect(packet.alert_labels).toEqual(["checkout", "sev2"]);
    expect(packet.exemplar_trace_ids).toEqual(["4bf92f3577b34da6"]);
    expect(packet.schema_version).toBe(PACKET_SCHEMA_VERSION);
  });

  it("accepts a quiet service that has no hot spans and a backfilled window", () => {
    const packet = accepted(
      payload({
        top_spans: [],
        window: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T12:00:00Z" },
      }),
    );

    expect(packet.top_spans).toEqual([]);
    expect(packet.window.end).toBe("2026-01-02T12:00:00Z");
  });

  it("keeps the optional sections and drops span attributes it does not define", () => {
    const packet = accepted(
      payload({
        top_spans: [
          { name: "GET /cart", count: 10, error_count: 0, p95_ms: 12, "http.route": "/cart" },
        ],
        signals: { ...(payload().signals as object), saturation: { cpu_pct: 91.5, queue_depth: 40 } },
        recent_deploy: { version: "v1.4.2", deployed_at: "2026-01-01T00:00:00Z", minutes_ago: 9 },
        log_snippets: ["upstream timeout"],
      }),
    );

    expect(packet.top_spans[0]).toEqual({ name: "GET /cart", count: 10, error_count: 0, p95_ms: 12 });
    expect(packet.signals.saturation).toEqual({ cpu_pct: 91.5, queue_depth: 40 });
    expect(packet.recent_deploy?.version).toBe("v1.4.2");
    expect(packet.log_snippets).toEqual(["upstream timeout"]);
  });

  it("shares no structure with the payload it was built from", () => {
    const input = payload();
    const packet = accepted(input);

    (input.top_spans as unknown[]).push({ name: "smuggled", count: 1, error_count: 1, p95_ms: 1 });
    (input.window as Record<string, unknown>).end = "2030-01-01T00:00:00Z";

    expect(packet.top_spans).toHaveLength(1);
    expect(packet.window.end).toBe("2026-01-01T00:05:00Z");
  });
});

describe("strict mode", () => {
  it("refuses an undeclared top-level field instead of ignoring it", () => {
    const errors = rejected(payload({ otlp_resource_spans: [{ anything: true }] }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^otlp_resource_spans: unexpected field/);
  });

  it("refuses undeclared fields inside signals and saturation", () => {
    const errors = rejected(
      payload({
        signals: {
          ...(payload().signals as object),
          guess: 1,
          saturation: { cpu_pct: 10, disk_pct: 50 },
        },
      }),
    );

    expect(errors.some((error) => error.startsWith("signals.guess: unexpected field"))).toBe(true);
    expect(
      errors.some((error) => error.startsWith("signals.saturation.disk_pct: unexpected field")),
    ).toBe(true);
  });

  it("refuses a schema version it does not implement without judging the fields", () => {
    const result = validatePacket(payload({ schema_version: 2, service: "" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_schema_version");
    expect(result.errors).toEqual(["schema_version: expected 1, received 2"]);
  });

  it("answers a payload that is not an object with one error rather than an exception", () => {
    for (const input of [[], "packet", 7, null, undefined, true]) {
      const result = validatePacket(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("malformed_payload");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^packet: expected a JSON object/);
    }
  });
});

describe("ranges and windows", () => {
  it("rejects a rate outside nought to one, whichever side it falls on", () => {
    expect(rejected(payload({ signals: { ...(payload().signals as object), error_rate: "high" } }))).toEqual([
      'signals.error_rate: expected number between 0 and 1, received "high"',
    ]);
    expect(rejected(payload({ signals: { ...(payload().signals as object), error_rate: 1.5 } }))).toEqual([
      "signals.error_rate: expected number between 0 and 1, received 1.5",
    ]);
  });

  it("rejects NaN and Infinity even though typeof reports them as numbers", () => {
    expect(
      rejected(payload({ signals: { ...(payload().signals as object), slo_burn_rate: Number.NaN } })),
    ).toEqual(["signals.slo_burn_rate: expected finite number of at least 0, received NaN"]);
    expect(
      rejected(
        payload({ signals: { ...(payload().signals as object), p95_latency_ms: Number.POSITIVE_INFINITY } }),
      ),
    ).toEqual(["signals.p95_latency_ms: expected finite number of at least 0, received Infinity"]);
  });

  it("rejects a negative latency and a percentage above one hundred", () => {
    const errors = rejected(
      payload({
        signals: {
          ...(payload().signals as object),
          p95_latency_baseline_ms: -1,
          saturation: { mem_pct: 140 },
        },
      }),
    );

    expect(errors).toContain("signals.p95_latency_baseline_ms: expected finite number of at least 0, received -1");
    expect(errors).toContain("signals.saturation.mem_pct: expected number between 0 and 100, received 140");
  });

  it("rejects a window whose end is not strictly after its start", () => {
    const reversed = rejected(
      payload({ window: { start: "2026-01-01T00:05:00Z", end: "2026-01-01T00:00:00Z" } }),
    );
    const empty = rejected(
      payload({ window: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" } }),
    );

    expect(reversed[0]).toMatch(/^window\.end: expected a timestamp strictly after/);
    expect(empty[0]).toMatch(/^window\.end: expected a timestamp strictly after/);
    expect(rejected(payload({ window: { start: "2026-01-01", end: "2026-01-01T00:05:00+01:00" } }))).toEqual([
      'window.start: expected an ISO 8601 UTC timestamp such as 2026-01-01T00:00:00Z, received "2026-01-01"',
      'window.end: expected an ISO 8601 UTC timestamp such as 2026-01-01T00:00:00Z, received "2026-01-01T00:05:00+01:00"',
    ]);
  });

  it("rejects arrays that outgrow their caps and a log snippet over five hundred characters", () => {
    const span = { name: "GET /", count: 1, error_count: 0, p95_ms: 1 };

    expect(rejected(payload({ top_spans: Array.from({ length: 21 }, () => span) }))).toEqual([
      "top_spans: expected at most 20 entries, received 21",
    ]);
    expect(
      rejected(payload({ exemplar_trace_ids: Array.from({ length: 11 }, (_, index) => `t${index}`) })),
    ).toEqual(["exemplar_trace_ids: expected at most 10 entries, received 11"]);
    expect(rejected(payload({ log_snippets: ["x".repeat(501)] }))[0]).toMatch(
      /^log_snippets\[0\]: expected a string of at most 500 characters/,
    );
  });

  it("reports every problem in one payload instead of stopping at the first", () => {
    const errors = rejected(
      payload({
        packet_id: "not a legal id",
        env: "production",
        top_spans: [{ name: "GET /", count: -1, error_count: 0, p95_ms: 1 }],
        alert_labels: ["sev1", 7],
      }),
    );

    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some((error) => error.startsWith("packet_id:"))).toBe(true);
    expect(errors.some((error) => error.startsWith("env: expected one of prod, staging, dev"))).toBe(true);
    expect(errors.some((error) => error.startsWith("top_spans[0].count:"))).toBe(true);
    expect(errors.some((error) => error.startsWith("alert_labels[1]:"))).toBe(true);
  });
});
