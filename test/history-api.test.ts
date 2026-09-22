import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import {
  clampHistoryLimit,
  HUMAN_LABELS,
  LabelRejectedError,
  MAX_LABEL_NOTE_LENGTH,
  type PacketDetail,
} from "../src/agent/api-types";
import {
  insertPacket,
  MAX_RECENT_PACKETS,
  recordJevAnswers,
  recordJevRun,
  recordVerdict,
  setPacketStatus,
  sqlTag,
  type SqlTag,
} from "../src/agent/store";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";

/**
 * The callable surface every channel reads history through.
 *
 * These tests populate an Agent's storage with the helpers the workflow's
 * completion path uses and then ask the Agent the same questions a browser, a
 * Slack app, or a replay script would ask. Nothing here drives a model or a
 * workflow: what is under test is the read and write API, and a live run would
 * take a minute to produce rows these helpers produce exactly.
 */

/**
 * Each case gets its own Durable Object so one test's rows cannot explain
 * another's result, matching how the storage tests reach an instance.
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
    },
    top_spans: [{ name: "POST /checkout", count: 1200, error_count: 264, p95_ms: 940 }],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    alert_labels: ["burn-rate", "checkout"],
    ...overrides,
  };
}

const JUDGED_AT = "2026-09-21T10:12:00.000Z";

/** The complete vectors a detail read has to be able to hand back untouched. */
const SEVERITY_ANSWER = {
  distribution: { sev0: 0.05, sev1: 0.62, sev2: 0.21, noise: 0.04 },
  noul: 0.08,
  argmax: { outcome: "sev1", p: 0.62 },
};

const CAUSE_ANSWER = {
  distribution: { deploy: 0.71, dependency: 0.18, load: 0.11 },
  noul: 0,
  argmax: { outcome: "deploy", p: 0.71 },
};

const VERDICT = {
  severity: "sev1",
  summary: "Error rate tripled shortly after the 2.4.1 rollout.",
  critique: "The priors put most of their mass on a deploy cause and the spans agree.",
  next_action: "Roll back to 2.4.0 and re-measure the error rate.",
  disagrees_with_prior: false,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  raw: { severity: "sev1" },
  created_at: JUDGED_AT,
};

/**
 * Three packets: one judged, one whose run stopped, and one older judged packet.
 *
 * They are inserted oldest first on purpose, so an assertion about newest-first
 * ordering is about the query rather than about the order rows arrived in.
 */
function seed(sql: SqlTag): void {
  insertPacket(
    sql,
    packet({ packet_id: "pkt-old", service: "search" }),
    "2026-09-21T10:00:00.000Z",
  );
  recordVerdict(sql, "pkt-old", { ...VERDICT, severity: "sev2" });
  setPacketStatus(sql, "pkt-old", "complete");

  insertPacket(sql, packet({ packet_id: "pkt-stopped" }), "2026-09-21T10:05:00.000Z");
  recordJevRun(sql, {
    packet_id: "pkt-stopped",
    model: null,
    status: "unavailable",
    reason: "System One did not answer",
    latency_ms: null,
    created_at: JUDGED_AT,
  });
  setPacketStatus(sql, "pkt-stopped", "failed");

  insertPacket(sql, packet({ packet_id: "pkt-new" }), "2026-09-21T10:10:00.000Z");
  recordJevRun(sql, {
    packet_id: "pkt-new",
    model: "jev-latest",
    status: "ok",
    reason: null,
    latency_ms: 412,
    created_at: JUDGED_AT,
  });
  recordJevAnswers(sql, "pkt-new", [
    { question_key: "severity", answer: SEVERITY_ANSWER, created_at: JUDGED_AT },
    { question_key: "cause", answer: CAUSE_ANSWER, created_at: JUDGED_AT },
  ]);
  recordVerdict(sql, "pkt-new", VERDICT);
  setPacketStatus(sql, "pkt-new", "complete");
}

describe("history listing", () => {
  it("returns rows newest first with the severity each packet was judged at", async () => {
    const rows = await withAgent("history-order", (sql, instance) => {
      seed(sql);
      return instance.getHistory();
    });

    expect(rows.map((row) => row.packet_id)).toEqual(["pkt-new", "pkt-stopped", "pkt-old"]);
    expect(rows.map((row) => row.severity)).toEqual(["sev1", null, "sev2"]);

    // Identity enough to choose a packet, and nothing that would make a listing
    // expensive: no payload, no distribution, no prose.
    expect(rows[0]).toEqual({
      packet_id: "pkt-new",
      service: "checkout",
      env: "prod",
      window_start: "2026-09-21T10:00:00Z",
      window_end: "2026-09-21T10:05:00Z",
      received_at: "2026-09-21T10:10:00.000Z",
      status: "complete",
      severity: "sev1",
    });
  });

  it("answers an empty page on an Agent that has stored nothing", async () => {
    const rows = await withAgent("history-empty", (_sql, instance) => instance.getHistory());

    expect(rows).toEqual([]);
  });

  it("keeps a packet whose run stopped in the list rather than hiding it", async () => {
    const rows = await withAgent("history-stopped", (sql, instance) => {
      seed(sql);
      return instance.getHistory();
    });

    const stopped = rows.find((row) => row.packet_id === "pkt-stopped");
    expect(stopped?.status).toBe("failed");
    expect(stopped?.severity).toBeNull();
  });

  it("clamps a requested limit at the low end and at the high end", async () => {
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-40)).toBe(1);
    expect(clampHistoryLimit(MAX_RECENT_PACKETS + 1)).toBe(MAX_RECENT_PACKETS);
    expect(clampHistoryLimit(10_000)).toBe(MAX_RECENT_PACKETS);
    expect(clampHistoryLimit(Number.NaN)).toBe(20);

    // Asking for nothing yields the one newest row rather than an empty page,
    // and asking for everything yields what is there rather than an error.
    const none = await withAgent("history-clamp", (sql, instance) => {
      seed(sql);
      return instance.getHistory(0);
    });
    expect(none.map((row) => row.packet_id)).toEqual(["pkt-new"]);

    const everything = await withAgent("history-clamp", (_sql, instance) =>
      instance.getHistory(10_000),
    );
    expect(everything).toHaveLength(3);
  });

  it("answers over the Agent stub, the way a connected client reaches it", async () => {
    const id = env.OTEL_JUDGE_AGENT.idFromName("history-stub");
    await withAgent("history-stub", (sql) => seed(sql));

    const stub = env.OTEL_JUDGE_AGENT.get(id);
    const rows = await stub.getHistory(2);

    // A distribution is whatever System One returned, so `PacketDetail` carries
    // `unknown` fields and the RPC return type degrades to `never`: the runtime
    // clones the values intact and only the static type gives up on them.
    const one = (await stub.getPacket("pkt-new")) as PacketDetail | null;

    expect(rows.map((row) => row.packet_id)).toEqual(["pkt-new", "pkt-stopped"]);
    expect(one?.verdict?.severity).toBe("sev1");
    expect(one?.jev_answers).toHaveLength(2);
  });
});

describe("packet detail", () => {
  it("hands back every question's whole vector and its noul mass", async () => {
    const found = await withAgent("detail-vectors", (sql, instance) => {
      seed(sql);
      return instance.getPacket("pkt-new");
    });

    expect(found?.jev_answers).toEqual([
      { ok: true, question_key: "severity", created_at: JUDGED_AT, answer: SEVERITY_ANSWER },
      { ok: true, question_key: "cause", created_at: JUDGED_AT, answer: CAUSE_ANSWER },
    ]);
    expect(found?.jev_run?.status).toBe("ok");
    expect(found?.verdict?.critique).toBe(VERDICT.critique);
    expect(found?.packet.payload.signals.slo_burn_rate).toBe(14.5);
  });

  it("answers null for an id this judge has never stored", async () => {
    const missing = await withAgent("detail-missing", (sql, instance) => {
      seed(sql);
      return instance.getPacket("pkt-never-seen");
    });

    expect(missing).toBeNull();
  });

  it("degrades one unreadable answer instead of the whole record", async () => {
    const found = await withAgent("detail-corrupt", (sql, instance) => {
      seed(sql);
      sql`INSERT INTO jev_answers (packet_id, question_key, answer_json, created_at)
        VALUES ('pkt-new', 'blast_radius', '{not json', ${JUDGED_AT})`;
      return instance.getPacket("pkt-new");
    });

    expect(found?.jev_answers).toHaveLength(3);
    expect(found?.jev_answers[0]?.ok).toBe(true);
    expect(found?.jev_answers[2]).toEqual({
      ok: false,
      question_key: "blast_radius",
      created_at: JUDGED_AT,
      error: "answer_json is not valid JSON",
    });
  });

  it("returns an accepted packet with no run, no answers, and no verdict", async () => {
    const found = await withAgent("detail-pending", (sql, instance) => {
      insertPacket(sql, packet({ packet_id: "pkt-waiting" }), "2026-09-21T11:00:00.000Z");
      return instance.getPacket("pkt-waiting");
    });

    expect(found?.packet.status).toBe("accepted");
    expect(found?.jev_run).toBeNull();
    expect(found?.jev_answers).toEqual([]);
    expect(found?.verdict).toBeNull();
    expect(found?.labels).toEqual([]);
  });
});

describe("human labels", () => {
  it.each(HUMAN_LABELS)("accepts %s and hands back the row it wrote", async (name) => {
    const written = await withAgent(`label-accept-${name}`, (sql, instance) => {
      seed(sql);
      return instance.labelPacket("pkt-new", name, "the rollback fixed it");
    });

    expect(written.label).toBe(name);
    expect(written.note).toBe("the rollback fixed it");
    expect(Date.parse(written.created_at)).not.toBeNaN();
  });

  it("refuses a word outside the vocabulary and writes nothing", async () => {
    await withAgent("label-unknown", (sql, instance) => {
      seed(sql);

      expect(() => instance.labelPacket("pkt-new", "sev3")).toThrow(LabelRejectedError);
      expect(() => instance.labelPacket("pkt-new", "")).toThrow(/is not a label/);
      expect(instance.getPacket("pkt-new")?.labels).toEqual([]);
    });
  });

  it("refuses a note over the cap rather than truncating it", async () => {
    await withAgent("label-long-note", (sql, instance) => {
      seed(sql);
      const tooLong = "x".repeat(MAX_LABEL_NOTE_LENGTH + 1);

      expect(() => instance.labelPacket("pkt-new", "wrong", tooLong)).toThrow(/the limit is 500/);

      // The boundary itself is allowed: the cap is a maximum, not a margin.
      const written = instance.labelPacket("pkt-new", "wrong", tooLong.slice(1));
      expect(written.note).toHaveLength(MAX_LABEL_NOTE_LENGTH);
    });
  });

  it("refuses an id this judge never stored", async () => {
    await withAgent("label-unknown-packet", (sql, instance) => {
      seed(sql);
      expect(() => instance.labelPacket("pkt-never-seen", "noise")).toThrow(/is not stored here/);
    });
  });

  it("leaves the verdict exactly as the judge recorded it", async () => {
    await withAgent("label-keeps-verdict", (sql, instance) => {
      seed(sql);
      const before = instance.getPacket("pkt-new");

      instance.labelPacket("pkt-new", "wrong", "this was a dependency, not the deploy");

      const after = instance.getPacket("pkt-new");
      expect(after?.verdict).toEqual(before?.verdict);
      expect(after?.jev_answers).toEqual(before?.jev_answers);
      expect(after?.packet.status).toBe("complete");
    });
  });

  it("keeps two disagreeing opinions in the order they arrived", async () => {
    const found = await withAgent("label-both", (sql, instance) => {
      seed(sql);
      instance.labelPacket("pkt-new", "sev1");
      instance.labelPacket("pkt-new", "noise", "the second responder disagreed");
      return instance.getPacket("pkt-new");
    });

    expect(found?.labels.map((entry) => entry.label)).toEqual(["sev1", "noise"]);
    expect(found?.labels.map((entry) => entry.note)).toEqual([
      null,
      "the second responder disagreed",
    ]);
  });
});

