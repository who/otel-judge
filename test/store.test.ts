import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import {
  countPackets,
  DuplicatePacketError,
  ensureSchema,
  getPacketRecord,
  hasPacket,
  insertPacket,
  listRecentPackets,
  recordHumanLabel,
  recordJevAnswers,
  recordJevRun,
  recordVerdict,
  sqlTag,
  type SqlTag,
} from "../src/agent/store";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";

/**
 * Each case gets its own Durable Object so one test's rows can never explain
 * another's result; the pool keeps instances alive across a file.
 *
 * `runInDurableObject` reaches an instance directly, so the lifecycle that
 * starts an Agent on its first request has not run and no table exists yet.
 * Starting it here is deliberate: every case below therefore runs against a
 * schema the production hook created, not one the test set up for itself.
 */
function withAgent<T>(
  name: string,
  body: (sql: SqlTag, instance: OtelJudgeAgent) => T | Promise<T>,
): Promise<T> {
  const stub = env.OTEL_JUDGE_AGENT.get(env.OTEL_JUDGE_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return body(sqlTag(instance), instance);
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
      saturation: { cpu_pct: 81, queue_depth: 320 },
    },
    top_spans: [{ name: "POST /checkout", count: 1200, error_count: 264, p95_ms: 940 }],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    alert_labels: ["burn-rate", "checkout"],
    recent_deploy: { version: "v412", deployed_at: "2026-09-21T09:52:00Z", minutes_ago: 8 },
    log_snippets: ["upstream connect error or disconnect/reset before headers"],
    ...overrides,
  };
}

/** A full System One answer: every outcome, plus the mass the model withheld. */
const DISTRIBUTION = {
  outcomes: {
    deploy_regression: 0.61,
    dependency_failure: 0.19,
    load_spike: 0.11,
    capacity_exhaustion: 0.06,
  },
  noul: 0.03,
  argmax: "deploy_regression",
};

describe("schema", () => {
  it("creates its tables twice over without complaint", async () => {
    await withAgent("schema-idempotent", (sql) => {
      ensureSchema(sql);
      ensureSchema(sql);
      expect(countPackets(sql)).toBe(0);
    });
  });

  it("reads an inserted packet back with its payload intact", async () => {
    const stored = await withAgent("schema-roundtrip", (sql) => {
      ensureSchema(sql);
      const subject = packet();
      insertPacket(sql, subject, "2026-09-21T10:05:30Z");

      expect(hasPacket(sql, "pkt-1")).toBe(true);
      expect(hasPacket(sql, "pkt-absent")).toBe(false);
      expect(countPackets(sql)).toBe(1);

      return getPacketRecord(sql, "pkt-1");
    });

    expect(stored?.packet.payload).toEqual(packet());
    expect(stored?.packet.status).toBe("accepted");
    expect(stored?.packet.schema_version).toBe(PACKET_SCHEMA_VERSION);
    expect(stored?.packet.window_start).toBe("2026-09-21T10:00:00Z");
    expect(stored?.packet.received_at).toBe("2026-09-21T10:05:30Z");
  });

  it("rejects a second insert of one packet id as a typed duplicate", async () => {
    await withAgent("schema-duplicate", (sql) => {
      insertPacket(sql, packet(), "2026-09-21T10:05:30Z");

      expect(() => insertPacket(sql, packet(), "2026-09-21T10:06:00Z")).toThrow(
        DuplicatePacketError,
      );
      expect(countPackets(sql)).toBe(1);
    });
  });
});

describe("distribution", () => {
  it("round-trips every outcome key and the noul mass", async () => {
    const record = await withAgent("distribution-roundtrip", (sql) => {
      insertPacket(sql, packet(), "2026-09-21T10:05:30Z");
      recordJevRun(sql, {
        packet_id: "pkt-1",
        model: "jev-latest",
        status: "ok",
        reason: null,
        latency_ms: 412,
        created_at: "2026-09-21T10:05:32Z",
      });
      recordJevAnswers(sql, "pkt-1", [
        { question_key: "root_cause", answer: DISTRIBUTION, created_at: "2026-09-21T10:05:32Z" },
      ]);

      return getPacketRecord(sql, "pkt-1");
    });

    const answer = record?.answers[0];
    expect(answer?.ok).toBe(true);
    expect(answer && answer.ok && answer.answer).toEqual(DISTRIBUTION);
    expect(answer && answer.ok && (answer.answer as typeof DISTRIBUTION).noul).toBe(0.03);
    expect(
      answer && answer.ok && Object.keys((answer.answer as typeof DISTRIBUTION).outcomes),
    ).toEqual(Object.keys(DISTRIBUTION.outcomes));
    expect(record?.jev_run?.status).toBe("ok");
    expect(record?.jev_run?.latency_ms).toBe(412);
  });

  it("stores an unavailable run with no answer rows at all", async () => {
    const record = await withAgent("distribution-unavailable", (sql) => {
      insertPacket(sql, packet({ packet_id: "pkt-quiet" }), "2026-09-21T11:00:00Z");
      recordJevRun(sql, {
        packet_id: "pkt-quiet",
        model: null,
        status: "unavailable",
        reason: "no JEV_API_KEY configured",
        latency_ms: null,
        created_at: "2026-09-21T11:00:01Z",
      });
      recordJevAnswers(sql, "pkt-quiet", []);

      return getPacketRecord(sql, "pkt-quiet");
    });

    expect(record?.jev_run?.status).toBe("unavailable");
    expect(record?.jev_run?.reason).toBe("no JEV_API_KEY configured");
    expect(record?.jev_run?.model).toBeNull();
    expect(record?.answers).toEqual([]);
  });

  it("replaces a replayed run's answers rather than stacking them", async () => {
    const record = await withAgent("distribution-replay", (sql) => {
      insertPacket(sql, packet({ packet_id: "pkt-retry" }), "2026-09-21T12:00:00Z");
      recordJevAnswers(sql, "pkt-retry", [
        { question_key: "root_cause", answer: DISTRIBUTION, created_at: "2026-09-21T12:00:01Z" },
      ]);
      recordJevRun(sql, {
        packet_id: "pkt-retry",
        model: "jev-latest",
        status: "error",
        reason: "timeout",
        latency_ms: 9000,
        created_at: "2026-09-21T12:00:01Z",
      });
      recordJevRun(sql, {
        packet_id: "pkt-retry",
        model: "jev-latest",
        status: "ok",
        reason: null,
        latency_ms: 380,
        created_at: "2026-09-21T12:00:09Z",
      });
      recordJevAnswers(sql, "pkt-retry", [
        { question_key: "root_cause", answer: DISTRIBUTION, created_at: "2026-09-21T12:00:09Z" },
        { question_key: "blast_radius", answer: DISTRIBUTION, created_at: "2026-09-21T12:00:09Z" },
      ]);

      return getPacketRecord(sql, "pkt-retry");
    });

    expect(record?.answers).toHaveLength(2);
    expect(record?.answers.map((answer) => answer.question_key)).toEqual([
      "root_cause",
      "blast_radius",
    ]);
    expect(record?.jev_run?.status).toBe("ok");
    expect(record?.jev_run?.created_at).toBe("2026-09-21T12:00:09Z");
  });
});

describe("verdict", () => {
  it("overwrites rather than fails when one packet is judged twice", async () => {
    const record = await withAgent("verdict-upsert", (sql) => {
      insertPacket(sql, packet(), "2026-09-21T10:05:30Z");
      recordVerdict(sql, "pkt-1", {
        severity: "warning",
        summary: "elevated errors",
        critique: null,
        next_action: "watch",
        disagrees_with_prior: null,
        model: "llama",
        raw: { severity: "warning" },
        created_at: "2026-09-21T10:06:00Z",
      });
      recordVerdict(sql, "pkt-1", {
        severity: "critical",
        summary: "deploy v412 regressed checkout",
        critique: "System One under-weighted the deploy",
        next_action: "roll back v412",
        disagrees_with_prior: true,
        model: "llama",
        raw: { severity: "critical", confidence: 0.82 },
        created_at: "2026-09-21T10:06:40Z",
      });

      return getPacketRecord(sql, "pkt-1");
    });

    expect(record?.verdict?.severity).toBe("critical");
    expect(record?.verdict?.summary).toBe("deploy v412 regressed checkout");
    expect(record?.verdict?.disagrees_with_prior).toBe(true);
    expect(record?.verdict?.raw).toEqual({ severity: "critical", confidence: 0.82 });
    expect(record?.verdict?.created_at).toBe("2026-09-21T10:06:40Z");
  });

  it("attaches a human label to the packet a verdict belongs to", async () => {
    const record = await withAgent("verdict-labelled", (sql) => {
      insertPacket(sql, packet({ packet_id: "pkt-labelled" }), "2026-09-21T13:00:00Z");
      recordVerdict(sql, "pkt-labelled", {
        severity: "critical",
        summary: "saturation",
        critique: null,
        next_action: null,
        disagrees_with_prior: false,
        model: "llama",
        raw: {},
        created_at: "2026-09-21T13:00:20Z",
      });
      recordHumanLabel(sql, "pkt-labelled", "false-positive", "load test, not traffic");
      recordHumanLabel(sql, "pkt-labelled", "noisy-alert");

      return getPacketRecord(sql, "pkt-labelled");
    });

    expect(record?.labels).toHaveLength(2);
    expect(record?.labels[0]?.label).toBe("false-positive");
    expect(record?.labels[0]?.note).toBe("load test, not traffic");
    expect(record?.labels[1]?.note).toBeNull();
    expect(record?.labels[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record?.verdict?.disagrees_with_prior).toBe(false);
  });
});

describe("history", () => {
  it("lists the newest packets first and never more than the cap", async () => {
    const listed = await withAgent("history-listing", (sql) => {
      insertPacket(sql, packet({ packet_id: "pkt-old" }), "2026-09-21T09:00:00Z");
      insertPacket(sql, packet({ packet_id: "pkt-mid" }), "2026-09-21T10:00:00Z");
      insertPacket(sql, packet({ packet_id: "pkt-new" }), "2026-09-21T11:00:00Z");

      return {
        all: listRecentPackets(sql, 10).map((row) => row.packet_id),
        two: listRecentPackets(sql, 2).map((row) => row.packet_id),
        none: listRecentPackets(sql, 0),
        negative: listRecentPackets(sql, -5),
        capped: listRecentPackets(sql, 5_000).length,
      };
    });

    expect(listed.all).toEqual(["pkt-new", "pkt-mid", "pkt-old"]);
    expect(listed.two).toEqual(["pkt-new", "pkt-mid"]);
    expect(listed.none).toEqual([]);
    expect(listed.negative).toEqual([]);
    expect(listed.capped).toBe(3);
  });

  it("answers null for a packet id nobody ever sent", async () => {
    const missing = await withAgent("history-missing", (sql) => getPacketRecord(sql, "pkt-nowhere"));

    expect(missing).toBeNull();
  });

  it("reports a corrupt answer without losing the rest of the record", async () => {
    const record = await withAgent("history-corrupt", (sql) => {
      insertPacket(sql, packet({ packet_id: "pkt-corrupt" }), "2026-09-21T14:00:00Z");
      recordJevAnswers(sql, "pkt-corrupt", [
        { question_key: "root_cause", answer: DISTRIBUTION, created_at: "2026-09-21T14:00:01Z" },
      ]);
      sql`INSERT INTO jev_answers (packet_id, question_key, answer_json, created_at)
        VALUES ('pkt-corrupt', 'blast_radius', '{not json', '2026-09-21T14:00:01Z')`;

      return getPacketRecord(sql, "pkt-corrupt");
    });

    expect(record?.answers).toHaveLength(2);
    expect(record?.answers[0]?.ok).toBe(true);
    expect(record?.answers[1]?.ok).toBe(false);
    expect(record?.answers[1] && !record.answers[1].ok && record.answers[1].error).toBe(
      "answer_json is not valid JSON",
    );
    expect(record?.packet.payload.packet_id).toBe("pkt-corrupt");
  });

  it("keeps an empty live board on wake; SQL history is the durable source", async () => {
    const seen = await withAgent("history-rehydrate", async (sql, instance) => {
      expect(instance.state.packets).toEqual([]);
      insertPacket(sql, packet({ packet_id: "pkt-a" }), "2026-09-21T15:00:00Z");
      insertPacket(sql, packet({ packet_id: "pkt-b" }), "2026-09-21T15:01:00Z");

      // A second start is what a wake after eviction looks like from in here.
      // Board chips are not rebuilt from SQL; getHistory remains the deliberate read.
      await instance.onStart();
      return { board: instance.state.packets.length, stored: countPackets(sql) };
    });

    expect(seen).toEqual({ board: 0, stored: 2 });
  });
});
