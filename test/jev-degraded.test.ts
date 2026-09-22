import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { getPacketRecord, insertPacket, recordJevRun, sqlTag, type SqlTag } from "../src/agent/store";
import { callSystemOne, type JevClientEnv } from "../src/jev/client";
import {
  isJevUsable,
  jevReason,
  jevStateStatus,
  MISSING_API_KEY,
  toJevMarker,
  toJevRunRow,
} from "../src/jev/degraded";
import type { SystemOneState } from "../src/jev/request";
import type { JevResult } from "../src/jev/types";
import { validatePacket } from "../src/packet/validate";
import { loadFixture } from "./fixtures.test";

/** The compact summary the summarize step would have handed the client. */
const STATE: SystemOneState = {
  service: "checkout",
  env: "prod",
  error_rate: 0.12,
  p95_latency_ms: 840,
};

const KEYED: JevClientEnv = { TYPESAFE_API_KEY: "secret-key" };

const originalFetch = globalThis.fetch;

/**
 * Replace fetch and count what the client did with it.
 *
 * Counting is the point rather than a detail: "performed no network call" is
 * the whole of the missing-key claim, and it cannot be asserted from a return
 * value that a slow, failed, real call would produce just as well.
 */
function stubFetch(reply: () => Response | Promise<Response>): { calls: number } {
  const record = { calls: 0 };
  globalThis.fetch = (() => {
    record.calls++;
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
  return record;
}

function rejectingFetch(error: unknown): { calls: number } {
  const record = { calls: 0 };
  globalThis.fetch = (() => {
    record.calls++;
    return Promise.reject(error);
  }) as unknown as typeof fetch;
  return record;
}

/** A fetch that fails the test if anything reaches it. */
function forbiddenFetch(): { calls: number } {
  return stubFetch(() => new Response("this call should never have been made", { status: 500 }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** One well-formed answer per question, used only to prove the ok path still maps. */
function okBody(): string {
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: [
      { key: "severity", distribution: { sev0: 0.1, sev1: 0.55, sev2: 0.2, noise: 0.05 }, noul: 0.1 },
      { key: "needs_human", distribution: { yes: 0.7, no: 0.25 }, noul: 0.05 },
      { key: "deploy_related", distribution: { yes: 0.8, no: 0.15 }, noul: 0.05 },
      { key: "noise_likely", distribution: { yes: 0.1, no: 0.88 }, noul: 0.02 },
      {
        key: "root_cause_family",
        distribution: { deploy_regression: 0.6, dependency: 0.2, saturation: 0.1, unknown: 0.05 },
        noul: 0.05,
      },
    ],
  });
}

/**
 * Every way a call can end, produced by the client itself.
 *
 * The results are not literals: the token table in `degraded.ts` reads prose
 * the client writes, and a test that hand-wrote the prose would keep passing on
 * the day the client reworded it. Driving the real function is what makes the
 * coupling between the two modules something a run can catch.
 */
async function everyFailure(): Promise<{ label: string; token: string; result: JevResult }[]> {
  const oversized: SystemOneState = { service: "x".repeat(9000) };

  const cases: { label: string; token: string; produce: () => Promise<JevResult> }[] = [
    {
      label: "no key configured",
      token: MISSING_API_KEY,
      produce: () => callSystemOne({}, STATE),
    },
    {
      label: "HTTP 500",
      token: "http_500",
      produce: () => {
        stubFetch(() => new Response("upstream is unwell", { status: 500 }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "HTTP 429",
      token: "http_429",
      produce: () => {
        stubFetch(() => new Response("slow down", { status: 429 }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "HTTP 401",
      token: "http_401",
      produce: () => {
        stubFetch(() => new Response("who are you", { status: 401 }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "timeout",
      token: "timeout",
      produce: () => {
        rejectingFetch(Object.assign(new Error("it took too long"), { name: "TimeoutError" }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "network rejection",
      token: "network_error",
      produce: () => {
        rejectingFetch(new TypeError("connection refused"));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "a body that is not JSON",
      token: "malformed_response",
      produce: () => {
        stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "a body missing a question",
      token: "malformed_response",
      produce: () => {
        stubFetch(() => new Response(JSON.stringify({ answers: [] }), { status: 200 }));
        return callSystemOne(KEYED, STATE);
      },
    },
    {
      label: "a state too large to send",
      token: "invalid_request",
      produce: () => callSystemOne(KEYED, oversized),
    },
  ];

  const produced: { label: string; token: string; result: JevResult }[] = [];
  for (const one of cases) produced.push({ ...one, result: await one.produce() });
  return produced;
}

/** A Durable Object of its own per case, started the way production starts one. */
function withAgent<T>(name: string, body: (sql: SqlTag) => T | Promise<T>): Promise<T> {
  const stub = env.OTEL_JUDGE_AGENT.get(env.OTEL_JUDGE_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return body(sqlTag(instance));
  });
}

/** The committed packet a degraded run is recorded against. */
function storePacket(sql: SqlTag): string {
  const validated = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!validated.ok) throw new Error(`fixture failed validation: ${validated.errors.join(" | ")}`);
  insertPacket(sql, validated.packet, "2026-09-22T10:00:00.000Z");
  return validated.packet.packet_id;
}

describe("a missing key short-circuits before the network", () => {
  it("performs no call at all and says so without retrying", async () => {
    const fetches = forbiddenFetch();

    const result = await callSystemOne({}, STATE);

    expect(fetches.calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toBe(MISSING_API_KEY);
    expect(result.status).toBeUndefined();
  });

  it("treats a key of whitespace as no key rather than sending it as a bearer", async () => {
    const fetches = forbiddenFetch();

    const result = await callSystemOne({ TYPESAFE_API_KEY: "  \n\t " }, STATE);

    expect(fetches.calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(MISSING_API_KEY);
  });

  it("offers callers the same test the short circuit makes", () => {
    expect(isJevUsable({})).toBe(false);
    expect(isJevUsable({ TYPESAFE_API_KEY: "" })).toBe(false);
    expect(isJevUsable({ TYPESAFE_API_KEY: "   " })).toBe(false);
    expect(isJevUsable({ TYPESAFE_API_KEY: "secret-key" })).toBe(true);
  });

  it("does not short-circuit a call that has a key to send", async () => {
    const fetches = stubFetch(() => new Response(okBody(), { status: 200 }));

    const result = await callSystemOne(KEYED, STATE);

    expect(fetches.calls).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe("failure reasons normalise onto stable tokens", () => {
  it("maps every variant the client can produce onto a documented token", async () => {
    for (const { label, token, result } of await everyFailure()) {
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(jevReason(result), label).toBe(token);
    }
  });

  it("calls an absent key unavailable and a rejected key an error", async () => {
    for (const { label, token, result } of await everyFailure()) {
      const row = toJevRunRow("pkt-1", result, "2026-09-22T10:00:01.000Z");
      expect(row.reason, label).toBe(token);
      expect(row.status, label).toBe(token === MISSING_API_KEY ? "unavailable" : "error");
      expect(row.model, label).toBeNull();
      expect(row.latency_ms, label).toBeNull();
    }
  });

  it("keeps one function over both paths, so a success still maps to an ok row", async () => {
    stubFetch(() => new Response(okBody(), { status: 200 }));

    const result = await callSystemOne(KEYED, STATE);
    const row = toJevRunRow("pkt-1", result, "2026-09-22T10:00:01.000Z");

    expect(row.status).toBe("ok");
    expect(row.reason).toBeNull();
    expect(row.model).toBe("jev-1.13.0");
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(jevStateStatus(result)).toBe("ok");
  });

  it("publishes every degraded outcome to a watching client as unavailable", async () => {
    for (const { label, result } of await everyFailure()) {
      expect(jevStateStatus(result), label).toBe("unavailable");
    }
  });

  it("stores a degraded run as one row with no answers beside it", async () => {
    const record = await withAgent("degraded-row", (sql) => {
      const packetId = storePacket(sql);
      const result: JevResult = { ok: false, retryable: false, reason: MISSING_API_KEY };
      recordJevRun(sql, toJevRunRow(packetId, result, "2026-09-22T10:00:01.000Z"));
      return getPacketRecord(sql, packetId);
    });

    expect(record?.jev_run?.status).toBe("unavailable");
    expect(record?.jev_run?.reason).toBe(MISSING_API_KEY);
    expect(record?.jev_run?.model).toBeNull();
    expect(record?.answers).toEqual([]);
  });

  it("upserts the one row when a retried workflow degrades again", async () => {
    const { count, record } = await withAgent("degraded-retry", (sql) => {
      const packetId = storePacket(sql);
      const first: JevResult = { ok: false, retryable: true, reason: "timed out after 10000ms" };
      const second: JevResult = { ok: false, retryable: false, reason: MISSING_API_KEY };
      recordJevRun(sql, toJevRunRow(packetId, first, "2026-09-22T10:00:01.000Z"));
      recordJevRun(sql, toJevRunRow(packetId, second, "2026-09-22T10:00:02.000Z"));
      const rows = sql<{ n: number }>`SELECT COUNT(*) AS n FROM jev_runs WHERE packet_id = ${packetId}`;
      return { count: rows[0]?.n, record: getPacketRecord(sql, packetId) };
    });

    expect(count).toBe(1);
    expect(record?.jev_run?.reason).toBe(MISSING_API_KEY);
    expect(record?.answers).toEqual([]);
  });
});

describe("no fabrication on any degraded path", () => {
  it("returns no answers, no distribution, and no default model", async () => {
    for (const { label, result } of await everyFailure()) {
      // The property checks are the claim; the serialised scan is what catches
      // a prior smuggled in under some other field name a later change adds.
      expect("answers" in result, label).toBe(false);
      expect("model" in result, label).toBe(false);
      const serialised = JSON.stringify(result);
      expect(serialised, label).not.toContain("distribution");
      expect(serialised, label).not.toContain("noul");
    }
  });

  it("hands downstream a marker that has nowhere to put a prior", async () => {
    for (const { label, token, result } of await everyFailure()) {
      const marker = toJevMarker(result);

      expect(marker.available, label).toBe(false);
      if (marker.available) continue;
      expect(marker.reason, label).toBe(token);
      expect(Object.keys(marker).sort(), label).toEqual(
        result.ok || result.status === undefined
          ? ["available", "reason"]
          : ["available", "reason", "status"],
      );
    }
  });

  it("stores nothing a later reader could mistake for a real prior", async () => {
    const record = await withAgent("degraded-no-fabrication", async (sql) => {
      const packetId = storePacket(sql);
      stubFetch(() => new Response("gone", { status: 503 }));
      const result = await callSystemOne(KEYED, STATE);
      recordJevRun(sql, toJevRunRow(packetId, result, "2026-09-22T10:00:03.000Z"));
      return getPacketRecord(sql, packetId);
    });

    expect(record?.jev_run?.status).toBe("error");
    expect(record?.jev_run?.reason).toBe("http_503");
    expect(record?.jev_run?.model).toBeNull();
    expect(record?.jev_run?.latency_ms).toBeNull();
    expect(record?.answers).toEqual([]);
  });
});
