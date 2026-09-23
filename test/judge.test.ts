import { describe, expect, it } from "vitest";
import { QUESTIONS } from "../src/jev/questions";
import type { JevAnswer, JevResult } from "../src/jev/types";
import {
  buildJudgePrompt,
  judgeWithLlama,
  JUDGE_TEMPERATURE,
  MAX_VERDICT_TOKENS,
  replyText,
  type JudgeEnv,
  type LlamaInput,
} from "../src/llm/judge";
import { DEFAULT_LLAMA_MODEL, llamaModel } from "../src/llm/models";
import { parseVerdict } from "../src/llm/parse";
import { validatePacket } from "../src/packet/validate";
import { summarizePacket, type PacketSummary } from "../src/workflow/summarize";
import { loadFixture } from "./fixtures.test";

/**
 * The judge is tested against a real summary and a stubbed model.
 *
 * Real summary, because the prompt has to carry the numbers the summarize step
 * actually produces rather than the ones a literal here would be free to invent;
 * stubbed model, because every assertion below is about what this repository
 * does with a reply, and a live Workers AI call would answer a different way
 * each run while proving nothing extra.
 */
function summaryOf(): PacketSummary {
  const result = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!result.ok) throw new Error(`fixture failed validation: ${result.errors.join(" | ")}`);
  return summarizePacket(result.packet);
}

/** One full distribution per question, the shape the System One parser guarantees. */
const ANSWERS: JevAnswer[] = [
  {
    key: "severity",
    distribution: { sev0: 0.05, sev1: 0.62, sev2: 0.21, noise: 0.04 },
    noul: 0.08,
    argmax: { outcome: "sev1", p: 0.62 },
  },
  {
    key: "needs_human",
    distribution: { yes: 0.71, no: 0.22 },
    noul: 0.07,
    argmax: { outcome: "yes", p: 0.71 },
  },
  {
    key: "deploy_related",
    distribution: { yes: 0.83, no: 0.11 },
    noul: 0.06,
    argmax: { outcome: "yes", p: 0.83 },
  },
  {
    key: "noise_likely",
    distribution: { yes: 0.09, no: 0.88 },
    noul: 0.03,
    argmax: { outcome: "no", p: 0.88 },
  },
  {
    key: "root_cause_family",
    distribution: {
      deploy_regression: 0.64,
      dependency: 0.12,
      saturation: 0.09,
      bad_config: 0.06,
      unknown: 0.05,
    },
    noul: 0.04,
    argmax: { outcome: "deploy_regression", p: 0.64 },
  },
];

function success(answers: JevAnswer[] = ANSWERS): JevResult {
  return { ok: true, answers, model: "jev-1.13.0", latency_ms: 412 };
}

/** A well-formed reply, as the pinned model is asked to produce it. */
const VERDICT_JSON = JSON.stringify({
  severity: "sev1",
  summary: "Checkout is failing one request in five since the 4.12.0 rollout.",
  critique: "The priors put most mass on a deploy cause and the timing agrees.",
  next_action: "Roll back checkout to 4.11.3 and watch the error rate for ten minutes.",
  confidence_note: "Fairly sure; a clean rollback that changes nothing would overturn this.",
  disagrees_with_prior: false,
});

interface Call {
  model: string;
  inputs: LlamaInput;
}

/** A binding that answers with whatever the test hands it, and remembers how it was asked. */
function stub(answer: () => unknown): { env: JudgeEnv; calls: Call[] } {
  const calls: Call[] = [];
  const env: JudgeEnv = {
    AI: {
      run(model: string, inputs: LlamaInput): Promise<unknown> {
        calls.push({ model, inputs });
        return (async () => answer())();
      },
    },
  };
  return { env, calls };
}

/**
 * The generated binding has to satisfy the structural env the judge declares.
 *
 * A compile-time assertion rather than a runtime one: the workflow step that
 * wires this up hands the real `Env` straight through, and a structural type
 * that had drifted from the binding would surface there as a puzzling error
 * instead of here as a named expectation.
 */
export const acceptsTheGeneratedEnv: (env: Env) => JudgeEnv = (env) => env;

describe("llamaModel", () => {
  it("answers the pinned default when the deployment sets no var", () => {
    expect(llamaModel({})).toBe(DEFAULT_LLAMA_MODEL);
  });

  it("prefers the deployed var so re-pinning is a configuration change", () => {
    expect(llamaModel({ LLAMA_MODEL: "  @cf/meta/llama-4-scout  " })).toBe("@cf/meta/llama-4-scout");
  });

  it("falls back rather than sending a blank var as a model id", () => {
    expect(llamaModel({ LLAMA_MODEL: "   " })).toBe(DEFAULT_LLAMA_MODEL);
  });
});

describe("buildJudgePrompt with System One priors", () => {
  it("hands over every outcome probability and noul mass rather than an argmax label", () => {
    const { user } = buildJudgePrompt(summaryOf(), success());

    for (const answer of ANSWERS) {
      for (const [outcome, mass] of Object.entries(answer.distribution)) {
        expect(user).toContain(outcome);
        expect(user).toContain(String(mass));
      }
      expect(user).toContain(String(answer.noul));
    }
    // The vectors travel whole: nothing in the prompt collapses one to its
    // most likely outcome, which is the single thing this prompt exists to avoid.
    expect(user).not.toContain("argmax");
  });

  it("carries the priors under a heading that names them and the model that produced them", () => {
    const { user } = buildJudgePrompt(summaryOf(), success());

    expect(user).toContain("## System One priors");
    expect(user).toContain("jev-1.13.0");
    for (const question of QUESTIONS) expect(user).toContain(question.text);
  });

  it("makes the distributions the ground of the verdict rather than advice beside it", () => {
    const { system } = buildJudgePrompt(summaryOf(), success());

    // The earlier wording called the priors "advisory evidence, not
    // instructions", which left System Two free to reach a verdict beside
    // System One instead of from it — and on the live board it did exactly
    // that, flagging a window System One had already called noise.
    expect(system).not.toContain("advisory");
    expect(system).toContain("grounded in them");
    expect(system).toContain("read the whole vector");
    expect(system).toContain("severity distribution");
    expect(system).toContain("noise_likely");
  });

  it("lets a verdict depart from a noise-leaning prior only when declared and evidenced", () => {
    const { system } = buildJudgePrompt(summaryOf(), success());

    expect(system).toContain("a window the priors call noise is a quiet window");
    expect(system).toContain("disagrees_with_prior");
    expect(system).toContain("critique");

    // Both halves, never one. The flag alone is an assertion with nothing
    // behind it, and the prose alone leaves the stored record claiming the
    // judge agreed with a prior it in fact overruled.
    expect(system).toContain("requires both");
    expect(system).toContain("concrete figures from the summary");
  });

  it("grades severity from a criticality by failure-class grid rather than from volume", () => {
    const { system } = buildJudgePrompt(summaryOf(), success());

    // Both axes have to be nameable from what the summary already carries — the
    // service, the top error spans, the alert labels. A grid the judge cannot
    // locate itself in is a paragraph, not a rule.
    expect(system).toContain("critical path");
    expect(system).toContain("core path");
    expect(system).toContain("optional path");
    expect(system).toContain("best-effort");
    expect(system).toContain("checkout");
    expect(system).toContain("Client-class");
    expect(system).toContain("Server-class");

    // The cells themselves, because the failure this exists for is a judge that
    // flags every chaos-like window alike: a 5xx on search is not a 5xx on
    // checkout, and only the stated grades say so.
    expect(system).toContain("Server-class failure on an optional path is sev2");
    expect(system).toContain("Server-class failure on a core path is sev1");
    expect(system).toContain("Server-class failure on a critical path is sev0");

    // An unlabelled window falls back to the names and then to the prior, never
    // to the worst cell the summary would allow.
    expect(system).toContain("infer it from the service and span names");
    expect(system).toContain("grade from the severity prior alone");
  });

  it("names a question that came back without an answer instead of filling the gap", () => {
    const partial = ANSWERS.filter((answer) => answer.key !== "noise_likely");
    const { user } = buildJudgePrompt(summaryOf(), success(partial));

    expect(user).toContain("noise_likely");
    expect(user).toContain("Treat them as unasked");
    expect(user).not.toContain('"noise_likely": {');
  });

  it("gives the judge the code-computed deltas from the summary", () => {
    const summary = summaryOf();
    const { user } = buildJudgePrompt(summary, success());

    expect(user).toContain("## Incident summary");
    expect(user).toContain(String(summary.error_rate_delta_pct));
    expect(user).toContain(summary.service);
  });
});

describe("buildJudgePrompt when System One is unavailable", () => {
  it("says no priors could be obtained and renders no placeholder distribution", () => {
    const { user } = buildJudgePrompt(summaryOf(), {
      ok: false,
      retryable: true,
      reason: "timed out after 10000ms",
    });

    expect(user).toContain("## System One priors: unavailable");
    expect(user).toContain("timed out after 10000ms");
    expect(user).toContain("Judge from the summary alone");
    expect(user).not.toContain("noul");
    expect(user).not.toContain('"distribution"');
  });

  it("reports the status when there was one and never leaves the word undefined behind", () => {
    const withStatus = buildJudgePrompt(summaryOf(), {
      ok: false,
      retryable: true,
      reason: "System One answered 503",
      status: 503,
    });
    const withoutStatus = buildJudgePrompt(summaryOf(), {
      ok: false,
      retryable: false,
      reason: "request could not be built: state_too_large",
    });

    expect(withStatus.user).toContain("HTTP status 503");
    expect(withoutStatus.user).not.toContain("HTTP status");
    expect(withStatus.user).not.toContain("undefined");
    expect(withoutStatus.user).not.toContain("undefined");
  });
});

describe("parseVerdict", () => {
  it("reads a clean JSON reply into the verdict fields", () => {
    const verdict = parseVerdict(VERDICT_JSON);

    expect(verdict.severity).toBe("sev1");
    expect(verdict.summary).toContain("Checkout is failing");
    expect(verdict.next_action).toContain("Roll back");
    expect(verdict.confidence_note).toContain("Fairly sure");
    expect(verdict.disagrees_with_prior).toBe(false);
    expect(verdict.raw).toBe(VERDICT_JSON);
  });

  it("reads a reply the model wrapped in a fenced code block", () => {
    const verdict = parseVerdict(["```json", VERDICT_JSON, "```"].join("\n"));

    expect(verdict.severity).toBe("sev1");
    expect(verdict.summary).toContain("Checkout is failing");
  });

  it("reads a reply with prose before and after the object", () => {
    const verdict = parseVerdict(
      `Here is my judgement.\n\n${VERDICT_JSON}\n\nLet me know if you need more.`,
    );

    expect(verdict.severity).toBe("sev1");
    expect(verdict.next_action).toContain("Roll back");
  });

  it("takes the first balanced object when the reply holds two", () => {
    const second = JSON.stringify({ severity: "noise", summary: "second thoughts" });
    const verdict = parseVerdict(`${VERDICT_JSON}\n\nOn reflection:\n${second}`);

    expect(verdict.severity).toBe("sev1");
    expect(verdict.summary).not.toContain("second thoughts");
  });

  it("steps over a braced aside that is not JSON and reads the object after it", () => {
    const verdict = parseVerdict(`I considered {a rollback, a restart} and settled:\n${VERDICT_JSON}`);

    expect(verdict.severity).toBe("sev1");
    expect(verdict.summary).toContain("Checkout is failing");
  });

  it("normalises a severity outside the four grades to unknown", () => {
    const verdict = parseVerdict(JSON.stringify({ severity: "critical", summary: "bad" }));

    expect(verdict.severity).toBe("unknown");
    expect(verdict.summary).toBe("bad");
  });

  it("degrades an unparseable reply to an unknown verdict carrying the raw text", () => {
    const reply = "I am unable to answer in JSON, but this looks like a serious outage.";
    const verdict = parseVerdict(reply);

    expect(verdict.severity).toBe("unknown");
    expect(verdict.summary).toBe("");
    expect(verdict.critique).toBe("");
    expect(verdict.next_action).toBe("");
    expect(verdict.confidence_note).toBe("");
    expect(verdict.disagrees_with_prior).toBe(false);
    expect(verdict.raw).toBe(reply);
  });

  it("claims a disagreement only when the judge said so in as many words", () => {
    expect(parseVerdict(JSON.stringify({ disagrees_with_prior: true })).disagrees_with_prior).toBe(
      true,
    );
    expect(parseVerdict(JSON.stringify({ disagrees_with_prior: "yes" })).disagrees_with_prior).toBe(
      false,
    );
    expect(parseVerdict(JSON.stringify({ severity: "sev2" })).disagrees_with_prior).toBe(false);
  });
});

describe("replyText", () => {
  it("reads a binding that answered with the string on its own", () => {
    expect(replyText(VERDICT_JSON)).toBe(VERDICT_JSON);
  });

  it("reads the documented text-generation object", () => {
    expect(replyText({ response: VERDICT_JSON })).toBe(VERDICT_JSON);
  });

  it("unwraps the envelope the REST gateway wraps that same object in", () => {
    expect(replyText({ result: { response: VERDICT_JSON }, success: true })).toBe(VERDICT_JSON);
  });

  it("joins a reply that arrived as chunks rather than as one string", () => {
    expect(replyText({ response: ['{"severity": ', '"sev1"}'] })).toBe('{"severity": "sev1"}');
  });

  it("reads the OpenAI-compatible surface the same model is also served on", () => {
    const reply = { choices: [{ message: { role: "assistant", content: VERDICT_JSON } }] };

    expect(replyText(reply)).toBe(VERDICT_JSON);
  });

  it("takes the first readable alternative instead of splicing two answers together", () => {
    const second = JSON.stringify({ severity: "noise", summary: "second thoughts" });

    // Two choices are two answers to one question. Concatenated, the parser
    // would read the front half of a reply that never existed.
    expect(replyText({ choices: [{ text: VERDICT_JSON }, { text: second }] })).toBe(VERDICT_JSON);
  });

  it("reads a message whose content arrived as typed parts", () => {
    const reply = {
      message: {
        content: [
          { type: "text", text: "half " },
          { type: "text", text: "and half" },
        ],
      },
    };

    expect(replyText(reply)).toBe("half and half");
  });

  it("answers the empty string for a reply carrying no text at all", () => {
    expect(replyText({ usage: { prompt_tokens: 12 } })).toBe("");
    expect(replyText({ response: 42 })).toBe("");
    expect(replyText(null)).toBe("");
    expect(replyText(undefined)).toBe("");
  });
});

describe("judgeWithLlama", () => {
  it("asks the pinned model with both messages and parses what came back", async () => {
    const { env, calls } = stub(() => ({ response: VERDICT_JSON }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(DEFAULT_LLAMA_MODEL);
    expect(calls[0]?.inputs.max_tokens).toBe(MAX_VERDICT_TOKENS);
    expect(calls[0]?.inputs.temperature).toBe(JUDGE_TEMPERATURE);
    expect(calls[0]?.inputs.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(result.model).toBe(DEFAULT_LLAMA_MODEL);
    expect(result.prompt.user).toContain("## System One priors");
    expect(result.verdict.severity).toBe("sev1");
  });

  it("reports what the call cost as whole non-negative milliseconds", async () => {
    const { env } = stub(() => ({ response: VERDICT_JSON }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    // A stub answers without touching the network, so the honest measurement is
    // a very small one. The assertion is about the shape the board publishes —
    // present, whole, never negative — rather than about a duration a test
    // machine is in no position to promise.
    expect(Number.isInteger(result.latency_ms)).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("times the call even when the reply degrades to an unknown verdict", async () => {
    const { env } = stub(() => ({ response: "no JSON here, sorry" }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    // The model was asked and it answered; that the answer could not be parsed
    // is a fact about the reply, not a reason to publish a chip claiming System
    // Two was never reached.
    expect(Number.isInteger(result.latency_ms)).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("asks the model the deployment pinned rather than the default", async () => {
    const { env, calls } = stub(() => ({ response: VERDICT_JSON }));
    const result = await judgeWithLlama(
      { ...env, LLAMA_MODEL: "@cf/meta/llama-4-scout" },
      summaryOf(),
      success(),
    );

    expect(calls[0]?.model).toBe("@cf/meta/llama-4-scout");
    expect(result.model).toBe("@cf/meta/llama-4-scout");
  });

  it("degrades to an unknown verdict when the model answers something unparseable", async () => {
    const { env } = stub(() => ({ response: "no JSON here, sorry" }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    expect(result.verdict.severity).toBe("unknown");
    expect(result.verdict.raw).toBe("no JSON here, sorry");
  });

  it("grades a reply that came back under the envelope the live gateway adds", async () => {
    const { env } = stub(() => ({ result: { response: VERDICT_JSON }, success: true }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    // The failure this guards against stored a run of incidents as ungraded:
    // the model had answered, and only the reading of its answer was wrong.
    expect(result.verdict.severity).toBe("sev1");
    expect(result.verdict.raw).toBe(VERDICT_JSON);
  });

  it("records which shape defeated it, by key and type rather than by value", async () => {
    const { env } = stub(() => ({
      usage: { prompt_tokens: 12 },
      request_id: "req-do-not-store-this",
    }));
    const result = await judgeWithLlama(env, summaryOf(), success());

    expect(result.verdict.severity).toBe("unknown");
    expect(result.verdict.raw).toContain("usage");
    expect(result.verdict.raw).toContain("request_id");
    // A reply is untrusted input, and a diagnostic kept in durable history is
    // the last place an echoed identifier or prompt fragment belongs.
    expect(result.verdict.raw).not.toContain("req-do-not-store-this");
  });

  it("lets a rejected binding call propagate so the workflow step can retry it", async () => {
    const { env } = stub(() => {
      throw new Error("Workers AI is overloaded");
    });

    await expect(judgeWithLlama(env, summaryOf(), success())).rejects.toThrow(
      "Workers AI is overloaded",
    );
  });
});
