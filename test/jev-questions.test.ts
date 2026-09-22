import { describe, expect, it } from "vitest";
import {
  QUESTIONS,
  ROOT_CAUSE_CHOICES,
  SEVERITY_CHOICES,
  type SystemOneQuestion,
} from "../src/jev/questions";
import {
  DEFAULT_JEV_MODEL,
  MAX_STATE_BYTES,
  SystemOneRequestError,
  buildSystemOneRequest,
  jevModel,
  type SystemOneState,
} from "../src/jev/request";

/** A summary the size the summarize step actually produces, rebuilt per call. */
function state(overrides: Record<string, unknown> = {}): SystemOneState {
  return {
    service: "checkout",
    env: "prod",
    error_rate: 0.12,
    error_rate_delta: 0.11,
    p95_latency_ms: 840,
    p95_latency_delta_ms: 630,
    slo_burn_rate: 3.2,
    top_spans: ["POST /checkout"],
    recent_deploy_minutes_ago: 7,
    ...overrides,
  } as SystemOneState;
}

describe("the MVP questions map", () => {
  it("holds exactly the five normative keys in their frozen order", () => {
    expect(QUESTIONS.map((question) => question.key)).toEqual([
      "severity",
      "needs_human",
      "deploy_related",
      "noise_likely",
      "root_cause_family",
    ]);
  });

  it("offers the documented choice sets and nothing else to choose from", () => {
    expect(SEVERITY_CHOICES).toEqual(["sev0", "sev1", "sev2", "noise"]);
    expect(ROOT_CAUSE_CHOICES).toEqual([
      "deploy_regression",
      "dependency",
      "saturation",
      "bad_config",
      "unknown",
    ]);

    const byKey = new Map<string, SystemOneQuestion>(
      (QUESTIONS as readonly SystemOneQuestion[]).map((question) => [question.key, question]),
    );
    expect(byKey.get("severity")?.choices).toEqual([...SEVERITY_CHOICES]);
    expect(byKey.get("root_cause_family")?.choices).toEqual([...ROOT_CAUSE_CHOICES]);
  });

  it("gives every choice question a closed set and no noul question one", () => {
    for (const question of QUESTIONS as readonly SystemOneQuestion[]) {
      expect(question.text.length).toBeGreaterThan(0);
      if (question.type === "choice") expect(question.choices?.length ?? 0).toBeGreaterThan(0);
      else expect(question.choices).toBeUndefined();
    }
  });

  it("refuses to be rewritten in place", () => {
    expect(Object.isFrozen(QUESTIONS)).toBe(true);
  });
});

describe("one batched request body", () => {
  it("carries all five questions in a single batch alongside the supplied state", () => {
    const summary = state();
    const body = buildSystemOneRequest(summary, { JEV_MODEL: "jev-1.13.0" });

    expect(body.questions.map((question) => question.key)).toEqual(
      QUESTIONS.map((question) => question.key),
    );
    expect(body.state).toEqual(summary);
  });

  it("batches without asking for a stream of any kind", () => {
    const body = buildSystemOneRequest(state(), {});

    expect("stream" in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(JSON.stringify(body)).not.toContain("stream");
  });

  it("rejects a batch whose state is over the size cap instead of sending it", () => {
    const oversize = state({ log_snippet: "x".repeat(MAX_STATE_BYTES + 1) });

    try {
      buildSystemOneRequest(oversize, {});
      throw new Error("expected the oversize state to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as SystemOneRequestError).code).toBe("state_too_large");
    }
  });
});

describe("the model id", () => {
  it("uses the pinned model when the var is set", () => {
    expect(jevModel({ JEV_MODEL: "jev-1.13.0" })).toBe("jev-1.13.0");
    expect(buildSystemOneRequest(state(), { JEV_MODEL: "jev-1.13.0" }).model).toBe("jev-1.13.0");
  });

  it("falls back to the documented default when the var is unset or blank", () => {
    expect(jevModel({})).toBe(DEFAULT_JEV_MODEL);
    expect(jevModel({ JEV_MODEL: "   " })).toBe(DEFAULT_JEV_MODEL);
    expect(DEFAULT_JEV_MODEL).toBe("jev-latest");
  });

  it("never lets an unset var travel as the string undefined", () => {
    const body = buildSystemOneRequest(state(), {});

    expect(body.model).toBe(DEFAULT_JEV_MODEL);
    expect(body.model).not.toContain("undefined");
  });
});
