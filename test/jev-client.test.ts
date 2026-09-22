import { afterEach, describe, expect, it } from "vitest";
import { callSystemOne, JEV_TIMEOUT_MS, SYSTEM_ONE_URL } from "../src/jev/client";
import { parseSystemOneResponse } from "../src/jev/parse";
import { QUESTIONS } from "../src/jev/questions";
import type { SystemOneState } from "../src/jev/request";

const KEYS = QUESTIONS.map((question) => question.key);

/** A compact summary of the shape the summarize step hands the client. */
const STATE: SystemOneState = {
  service: "checkout",
  env: "prod",
  error_rate: 0.12,
  p95_latency_ms: 840,
  slo_burn_rate: 3.2,
};

/** One well-formed answer per question, each with its mass fully accounted for. */
function answers(): Record<string, unknown>[] {
  return [
    { key: "severity", distribution: { sev0: 0.1, sev1: 0.55, sev2: 0.2, noise: 0.05 }, noul: 0.1 },
    { key: "needs_human", distribution: { yes: 0.7, no: 0.25 }, noul: 0.05 },
    { key: "deploy_related", distribution: { yes: 0.8, no: 0.15 }, noul: 0.05 },
    { key: "noise_likely", distribution: { yes: 0.1, no: 0.88 }, noul: 0.02 },
    {
      key: "root_cause_family",
      distribution: {
        deploy_regression: 0.6,
        dependency: 0.1,
        saturation: 0.1,
        bad_config: 0.1,
        unknown: 0.05,
      },
      noul: 0.05,
    },
  ];
}

function okBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "jev-1.13.0", answers: answers(), ...overrides });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;

/** Replace the runtime fetch for one test, recording what the client sent. */
function stubFetch(reply: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(reply(call));
  }) as unknown as typeof fetch;
  return calls;
}

function rejectingFetch(error: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.reject(error);
  }) as unknown as typeof fetch;
  return calls;
}

// Restored whatever the test did with it, so a stub cannot leak into the next
// file and quietly answer a request some other suite meant to make for real.
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a successful batched call", () => {
  it("returns every question key carrying its full distributions and noul mass", async () => {
    stubFetch(() => new Response(okBody(), { status: 200 }));

    const result = await callSystemOne({ TYPESAFE_API_KEY: "secret-key" }, STATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.map((answer) => answer.key)).toEqual(KEYS);
    expect(result.answers[0]?.distribution).toEqual({ sev0: 0.1, sev1: 0.55, sev2: 0.2, noise: 0.05 });
    expect(result.answers[0]?.noul).toBe(0.1);
    expect(result.answers[4]?.distribution.deploy_regression).toBe(0.6);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("adds an argmax beside the distributions rather than in place of them", async () => {
    stubFetch(() => new Response(okBody(), { status: 200 }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const severity = result.answers[0];
    expect(severity?.argmax).toEqual({ outcome: "sev1", p: 0.55 });
    expect(Object.keys(severity?.distribution ?? {})).toHaveLength(4);
    expect(result.answers[4]?.argmax.outcome).toBe("deploy_regression");
  });

  it("posts one batched request with bearer auth, JSON, and a timeout signal", async () => {
    const calls = stubFetch(() => new Response(okBody(), { status: 200 }));

    await callSystemOne({ TYPESAFE_API_KEY: "secret-key", JEV_MODEL: "jev-1.13.0" }, STATE);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(SYSTEM_ONE_URL);
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JEV_TIMEOUT_MS).toBe(10_000);

    const sent = JSON.parse(String(call?.init?.body)) as { model: string; questions: unknown[] };
    expect(sent.model).toBe("jev-1.13.0");
    expect(sent.questions).toHaveLength(KEYS.length);
  });

  it("omits the authorization header rather than sending an undefined bearer", async () => {
    const calls = stubFetch(() => new Response(okBody(), { status: 200 }));

    await callSystemOne({}, STATE);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect("authorization" in headers).toBe(false);
    expect(JSON.stringify(headers)).not.toContain("undefined");
  });
});

describe("transport and status failures", () => {
  it("flags HTTP 500 retryable and reports the status it saw", async () => {
    const calls = stubFetch(() => new Response("upstream is unwell", { status: 500 }));

    const result = await callSystemOne({ TYPESAFE_API_KEY: "secret-key" }, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(500);
    // One attempt and no more: retries are the workflow's to own and to count.
    expect(calls).toHaveLength(1);
  });

  it("flags HTTP 429 retryable", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(429);
  });

  it("flags a network rejection retryable and names it a network error", async () => {
    rejectingFetch(new TypeError("connection refused"));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("network error");
    expect(result.status).toBeUndefined();
  });

  it("flags a timeout retryable and tells it apart from a network error", async () => {
    rejectingFetch(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("timed out");
    expect(result.reason).not.toContain("network error");
  });

  it("flags every other 4xx non-retryable", async () => {
    for (const status of [400, 401, 403, 404]) {
      stubFetch(() => new Response("no", { status }));

      const result = await callSystemOne({ TYPESAFE_API_KEY: "secret-key" }, STATE);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.retryable).toBe(false);
      expect(result.status).toBe(status);
    }
  });
});

describe("a body that cannot be read", () => {
  it("returns a non-retryable malformed failure when the mass does not sum to one", async () => {
    const short = answers();
    short[1] = { key: "needs_human", distribution: { yes: 0.2, no: 0.2 }, noul: 0.1 };
    stubFetch(() => new Response(JSON.stringify({ answers: short }), { status: 200 }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("malformed response");
    expect(result.reason).toContain("needs_human");
  });

  it("treats a vector summing to one beside a positive noul as malformed", async () => {
    const overfull = answers();
    overfull[3] = { key: "noise_likely", distribution: { yes: 0.4, no: 0.6 }, noul: 0.3 };
    stubFetch(() => new Response(JSON.stringify({ answers: overfull }), { status: 200 }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("noise_likely");
  });

  it("treats an HTML or empty 200 as malformed instead of throwing", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const html = await callSystemOne({}, STATE);

    expect(html.ok).toBe(false);
    if (html.ok) return;
    expect(html.retryable).toBe(false);
    expect(html.reason).toContain("not JSON");

    stubFetch(() => new Response("", { status: 200 }));
    const empty = await callSystemOne({}, STATE);

    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.retryable).toBe(false);
  });

  it("treats a response missing one question key as malformed", async () => {
    const four = answers().filter((answer) => answer.key !== "deploy_related");
    stubFetch(() => new Response(JSON.stringify({ answers: four }), { status: 200 }));

    const result = await callSystemOne({}, STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("deploy_related");
  });

  it("treats a negative or non-finite probability as malformed", () => {
    const negative = answers();
    negative[0] = { key: "severity", distribution: { sev0: -0.1, sev1: 1.1 }, noul: 0 };
    expect(parseSystemOneResponse({ answers: negative }).ok).toBe(false);

    const notANumber = answers();
    notANumber[0] = { key: "severity", distribution: { sev0: Number.NaN, sev1: 1 }, noul: 0 };
    expect(parseSystemOneResponse({ answers: notANumber }).ok).toBe(false);
  });
});
