import { describe, expect, it } from "vitest";
import type { JevAnswer, JevResult } from "../src/jev/types";
import { judgeWithLlama, type JudgeEnv, type LlamaInput } from "../src/llm/judge";
import { parseVerdict } from "../src/llm/parse";
import {
  applyPriorDeference,
  isNoiseMajority,
  noiseMass,
  NOISE_MAJORITY_THRESHOLD,
} from "../src/llm/priorDeference";
import { validatePacket } from "../src/packet/validate";
import { summarizePacket, type PacketSummary } from "../src/workflow/summarize";
import { loadFixture } from "./fixtures.test";

/**
 * Deference is tested as arithmetic over two priors and one flag.
 *
 * Every case below is a pair of numbers System One could return and a verdict
 * System Two could write, because that pair is the whole of what the rule reads.
 * The one test that goes through `judgeWithLlama` is there for a different
 * reason: a pure function nothing calls would pass every assertion above it
 * while the board went on painting the flag this bead exists to stop.
 */

/** A prior set where only the two noise-bearing questions vary. */
function priors(noise: number, noiseLikelyYes: number): JevResult {
  const answers: JevAnswer[] = [
    {
      key: "severity",
      distribution: { sev0: 0.01, sev1: (1 - noise) / 2, sev2: (1 - noise) / 2, noise },
      noul: 0,
      argmax: { outcome: "noise", p: noise },
    },
    {
      key: "needs_human",
      distribution: { yes: 0.12, no: 0.88 },
      noul: 0.12,
      argmax: { outcome: "no", p: 0.88 },
    },
    {
      key: "deploy_related",
      distribution: { yes: 0.08, no: 0.92 },
      noul: 0.08,
      argmax: { outcome: "no", p: 0.92 },
    },
    {
      key: "noise_likely",
      distribution: { yes: noiseLikelyYes, no: 1 - noiseLikelyYes },
      noul: noiseLikelyYes,
      argmax:
        noiseLikelyYes >= 0.5
          ? { outcome: "yes", p: noiseLikelyYes }
          : { outcome: "no", p: 1 - noiseLikelyYes },
    },
    {
      key: "root_cause_family",
      distribution: {
        deploy_regression: 0.09,
        dependency: 0.11,
        saturation: 0.14,
        bad_config: 0.06,
        unknown: 0.6,
      },
      noul: 0,
      argmax: { outcome: "unknown", p: 0.6 },
    },
  ];
  return { ok: true, answers, model: "jev-1.13.0", latency_ms: 118 };
}

/** The priors chaos noise actually produces: System One is all but certain. */
function noiseMajority(): JevResult {
  return priors(0.99, 0.97);
}

const FAILED_PRIORS: JevResult = {
  ok: false,
  retryable: false,
  reason: "System One returned HTTP 503",
  status: 503,
};

/** A graded verdict, as the parser hands one over. */
function verdictOf(severity: string, disagrees: boolean) {
  return parseVerdict(
    JSON.stringify({
      severity,
      summary: "Checkout returned a 500 during the window.",
      critique: "The summary shows one failing request and the priors call it noise.",
      next_action: "Watch the error rate for ten minutes.",
      confidence_note: "Not very sure; the window is short.",
      disagrees_with_prior: disagrees,
    }),
  );
}

function summaryOf(): PacketSummary {
  const result = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!result.ok) throw new Error(`fixture failed validation: ${result.errors.join(" | ")}`);
  return summarizePacket(result.packet);
}

/** A binding that answers with one fixed reply. */
function stub(reply: string): JudgeEnv {
  return {
    AI: {
      run(_model: string, _inputs: LlamaInput): Promise<unknown> {
        return Promise.resolve({ response: reply });
      },
    },
  };
}

describe("noiseMass", () => {
  it("takes the strongest of the two questions that speak to noise", () => {
    expect(noiseMass(priors(0.42, 0.91))).toBe(0.91);
    expect(noiseMass(priors(0.88, 0.13))).toBe(0.88);
  });

  it("reads nothing out of a run that produced no priors", () => {
    expect(noiseMass(FAILED_PRIORS)).toBe(0);
    expect(isNoiseMajority(FAILED_PRIORS)).toBe(false);
  });

  it("defers at the threshold rather than above it", () => {
    expect(NOISE_MAJORITY_THRESHOLD).toBe(0.7);
    expect(isNoiseMajority(priors(0.7, 0.1))).toBe(true);
    expect(isNoiseMajority(priors(0.69, 0.1))).toBe(false);
  });
});

describe("applyPriorDeference", () => {
  it("coerces an undisputed incident grade to noise", () => {
    const deferred = applyPriorDeference(verdictOf("sev1", false), noiseMajority());

    expect(deferred.severity).toBe("noise");
    expect(deferred.critique).toContain("deferred to System One");
    expect(deferred.critique).toContain("sev1");
  });

  it("coerces sev2 and sev0 the same way", () => {
    expect(applyPriorDeference(verdictOf("sev2", false), noiseMajority()).severity).toBe("noise");
    expect(applyPriorDeference(verdictOf("sev0", false), noiseMajority()).severity).toBe("noise");
  });

  it("keeps the raw reply the model sent", () => {
    const written = verdictOf("sev1", false);
    const deferred = applyPriorDeference(written, noiseMajority());

    expect(deferred.raw).toBe(written.raw);
    expect(deferred.summary).toBe(written.summary);
    expect(deferred.next_action).toBe(written.next_action);
  });

  it("leaves a declared disagreement alone", () => {
    const written = verdictOf("sev1", true);

    expect(applyPriorDeference(written, noiseMajority())).toEqual(written);
  });

  it("leaves a verdict alone when the priors are not noise-majority", () => {
    const written = verdictOf("sev1", false);

    expect(applyPriorDeference(written, priors(0.62, 0.41))).toEqual(written);
  });

  it("defers on the noise_likely prior alone", () => {
    expect(applyPriorDeference(verdictOf("sev1", false), priors(0.2, 0.91)).severity).toBe("noise");
  });

  it("leaves a verdict alone when System One never answered", () => {
    const written = verdictOf("sev1", false);

    expect(applyPriorDeference(written, FAILED_PRIORS)).toEqual(written);
  });

  it("does not invent a grade for a reply it could not read", () => {
    const unreadable = parseVerdict("the model apologised and said nothing else");

    expect(unreadable.severity).toBe("unknown");
    expect(applyPriorDeference(unreadable, noiseMajority())).toEqual(unreadable);
  });

  it("leaves a verdict that already agreed untouched", () => {
    const written = verdictOf("noise", false);

    expect(applyPriorDeference(written, noiseMajority())).toEqual(written);
  });
});

describe("judgeWithLlama", () => {
  it("returns the deferred severity, so the board and SQL see one word", async () => {
    const reply = JSON.stringify({
      severity: "sev2",
      summary: "Checkout returned a 500.",
      critique: "One failing request in a quiet window.",
      next_action: "Keep watching.",
      confidence_note: "Not sure.",
      disagrees_with_prior: false,
    });

    const result = await judgeWithLlama(stub(reply), summaryOf(), noiseMajority());

    expect(result.verdict.severity).toBe("noise");
  });

  it("returns what the judge graded when it said it disagreed", async () => {
    const reply = JSON.stringify({
      severity: "sev2",
      summary: "Checkout returned a 500.",
      critique: "The priors call this noise and the error share says otherwise.",
      next_action: "Page the on-call.",
      confidence_note: "Fairly sure.",
      disagrees_with_prior: true,
    });

    const result = await judgeWithLlama(stub(reply), summaryOf(), noiseMajority());

    expect(result.verdict.severity).toBe("sev2");
  });
});
