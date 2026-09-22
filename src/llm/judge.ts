import { QUESTIONS, SEVERITY_CHOICES } from "../jev/questions";
import type { JevAnswer, JevResult } from "../jev/types";
import type { PacketSummary } from "../workflow/summarize";
import { llamaModel, type LlamaEnv } from "./models";
import { parseVerdict } from "./parse";

/**
 * System Two: the model that reads the summary and the priors and says what it thinks.
 *
 * The whole of this module's opinion about System One is that its answers are
 * evidence. The distributions are handed over entire — every outcome with its
 * mass, plus the mass the model placed on none of them — and the prompt says in
 * as many words that the judge may disagree with them so long as it explains
 * itself. Nothing here compares a probability with anything: no code path reads
 * a number out of a prior to decide routing, to block a verdict, or to demand a
 * human, because a judge whose output is gated by an arithmetic threshold is a
 * threshold wearing a judge's clothes.
 */

/** How many tokens one verdict may take; a structured answer with prose fields fits well inside. */
export const MAX_VERDICT_TOKENS = 700;

/** Low, because the answer is a structured verdict rather than an essay that benefits from variety. */
export const JUDGE_TEMPERATURE = 0.2;

/**
 * The severities a verdict may carry.
 *
 * Derived from the choices System One was offered rather than declared again, so
 * the two models can never end up grading on different scales, plus `unknown`
 * for a reply that named something else or could not be read at all.
 */
export type VerdictSeverity = (typeof SEVERITY_CHOICES)[number] | "unknown";

/**
 * What System Two concluded about one incident window.
 *
 * This shape is durable stored history — it is written to `verdicts` and
 * rendered by the demo channel — so fields may be added but never renamed.
 * `confidence_note` is prose on purpose: the judge says how sure it is in words
 * that a human reads, and no number is produced for anything to compare against.
 * `raw` carries the model's reply exactly as it arrived, which is what keeps the
 * reasoning trail readable after a parse has smoothed the reply into fields.
 */
export interface Verdict {
  severity: VerdictSeverity;
  summary: string;
  critique: string;
  next_action: string;
  confidence_note: string;
  disagrees_with_prior: boolean;
  raw: string;
}

/** The two messages one judgement is made of, kept apart so both can be stored and asserted on. */
export interface JudgePrompt {
  system: string;
  user: string;
}

/** One chat message, in the shape every Workers AI instruct model takes. */
export interface LlamaMessage {
  role: "system" | "user";
  content: string;
}

/** The input of one text-generation call, written out rather than inferred from the binding. */
export interface LlamaInput {
  messages: LlamaMessage[];
  max_tokens: number;
  temperature: number;
}

/**
 * The slice of the AI binding this module uses.
 *
 * Declared structurally for the same reason the System One client declares its
 * env: a test stands one up as an object literal, with no account, no
 * entitlement and no network between the assertion and the behaviour.
 */
export interface LlamaBinding {
  run(model: string, inputs: LlamaInput): Promise<unknown>;
}

/** What the judge needs from the environment: the binding and, optionally, the pin. */
export interface JudgeEnv extends LlamaEnv {
  readonly AI: LlamaBinding;
}

/** A verdict, with the model that produced it and the prompt it answered. */
export interface JudgeResult {
  verdict: Verdict;
  model: string;
  prompt: JudgePrompt;
}

/**
 * The standing instructions, identical for every packet.
 *
 * Two of these paragraphs are normative rather than stylistic. The priors are
 * the ground the verdict stands on and a departure from them has to be declared
 * and evidenced, because a System Two that quietly overrules System One is a
 * second opinion nobody can audit, while one that only ever ratifies it is an
 * expensive way to reprint a distribution. And confidence is narrated, never
 * enforced: the judge is told plainly that no
 * number it writes routes or blocks anything, so it has no reason to shade one
 * to obtain an outcome.
 */
const SYSTEM_MESSAGE = [
  "You are the judge in a two-model pipeline that reviews production telemetry.",
  "You are given a compact, code-computed summary of one incident window and, when they can be obtained, another model's probability distributions over a fixed set of questions about that window.",
  "",
  "The distributions are your priors, not background colour. They are the first model's reading of this same window, and your verdict has to be grounded in them: read the whole vector for every question — where the mass sits, how spread it is, and how much of it the model declined — and name in the critique which distributions carry your answer. Severity and noise_likely bind hardest. Your severity should follow the severity distribution, and a window the priors call noise is a quiet window unless the summary contradicts them in numbers.",
  "",
  "You may still disagree, and sometimes you must. Departing from where the priors put their mass — grading a noise-leaning window as an incident above all — requires both: set \"disagrees_with_prior\" to true, and cite in the critique the concrete figures from the summary that contradict the prior. A disagreement with no cited number is not a disagreement, and a verdict that quietly ignores a prior is worse than either.",
  "",
  "Every arithmetic comparison in the summary was computed in code before you were asked, so treat the deltas as facts and spend your effort on what they mean.",
  "",
  "No number decides anything here. Your confidence is narrated in prose for a human to read; it never routes the incident, never blocks your verdict, and never summons anyone on its own. Do not withhold a judgement because you are unsure — say what you think and say how sure you are.",
  "",
  "Answer with one JSON object and nothing else. No preamble, no code fence, no commentary after it.",
  "",
  "{",
  `  "severity": one of ${SEVERITY_CHOICES.join(", ")}, or unknown when the summary cannot support a grade,`,
  '  "summary": one sentence naming what is happening to this service,',
  '  "critique": what the evidence does and does not support, naming the priors your verdict rests on and the summary figures behind any disagreement,',
  '  "next_action": the single next thing a responder should do,',
  '  "confidence_note": prose on how sure you are and what would change your mind,',
  '  "disagrees_with_prior": true when your verdict departs from the priors, false otherwise',
  "}",
].join("\n");

/** One prior, rendered whole: the question as asked, the full vector, and the declined mass. */
function renderedPrior(answer: JevAnswer): Record<string, unknown> {
  const question = QUESTIONS.find((candidate) => candidate.key === answer.key);
  return {
    question: question?.text ?? answer.key,
    // The distribution is copied out field by field rather than summarised. An
    // argmax is a claim about the vector, and a judge handed the claim instead
    // of the vector cannot tell a confident answer from a flat one.
    distribution: { ...answer.distribution },
    noul: answer.noul,
  };
}

/**
 * The priors section, or a statement that there are none.
 *
 * The unavailable branch names the reason and asks for a judgement anyway, which
 * is the PRD's position: an unreachable System One degrades the evidence and
 * does not stop the judge. Nothing resembling a distribution appears in that
 * branch — not a uniform one, not a zeroed one — because a placeholder vector is
 * a prior nobody computed, and the failure reason is the only thing there is to
 * say.
 */
function priorsSection(jev: JevResult): string {
  if (!jev.ok) {
    const statusLine =
      jev.status === undefined ? "" : ` The call ended with HTTP status ${jev.status}.`;
    return [
      "## System One priors: unavailable",
      "",
      `No priors could be obtained for this packet: ${jev.reason}.${statusLine}`,
      "No distribution is offered for any question and none may be assumed. Judge from the summary alone and record in the critique that you had no priors.",
    ].join("\n");
  }

  const priors: Record<string, unknown> = {};
  for (const answer of jev.answers) priors[answer.key] = renderedPrior(answer);

  // Defensive: the parser refuses a body that is missing a question, so a gap
  // here should be impossible. If one ever arrives, the absent question is named
  // rather than quietly omitted, because a judge that cannot see which questions
  // went unanswered will read the remaining ones as the whole picture.
  const absent = QUESTIONS.map((question) => question.key).filter((key) => !(key in priors));

  const section = [
    "## System One priors",
    "",
    `Produced by ${jev.model}. Each entry gives the mass on every offered outcome, plus "noul": the mass the model placed on none of them. A question answered mostly with noul is a question that model declined, not a question answered no.`,
    "",
    JSON.stringify(priors, null, 2),
  ];

  if (absent.length > 0) {
    section.push(
      "",
      `These questions were asked and came back without an answer: ${absent.join(", ")}. Treat them as unasked rather than as answered with no mass.`,
    );
  }

  return section.join("\n");
}

/**
 * Assemble the two messages for one packet.
 *
 * Pure and deterministic, so the prompt a stored verdict answered can be rebuilt
 * from the same summary and priors months later, and so a test can assert on
 * what the model was told without a model in the room.
 */
export function buildJudgePrompt(summary: PacketSummary, jev: JevResult): JudgePrompt {
  const user = [
    "## Incident summary",
    "",
    JSON.stringify(summary, null, 2),
    "",
    priorsSection(jev),
    "",
    "Now answer with the JSON object described in your instructions.",
  ].join("\n");

  return { system: SYSTEM_MESSAGE, user };
}

/**
 * Pull the generated text out of whatever the binding answered with.
 *
 * Workers AI returns an object carrying `response` for a text-generation model
 * and, for some models and gateways, the string on its own. An unrecognised
 * shape becomes the empty string rather than an exception: the parser already
 * has a documented answer for a reply it cannot read, and there is no reason for
 * this function to invent a second one.
 */
function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (typeof reply === "object" && reply !== null && "response" in reply) {
    const response = (reply as { response: unknown }).response;
    if (typeof response === "string") return response;
  }
  return "";
}

/**
 * Ask the judge, once, and return what it said.
 *
 * A rejected binding call propagates on purpose. An unreachable or overloaded
 * Workers AI is exactly the condition a durable workflow step exists to retry,
 * and swallowing it here would turn a transient outage into a permanent
 * unknown-severity verdict in stored history. Only an unreadable reply degrades,
 * because a model that answered something is a model that will answer the same
 * something again.
 */
export async function judgeWithLlama(
  env: JudgeEnv,
  summary: PacketSummary,
  jev: JevResult,
): Promise<JudgeResult> {
  const model = llamaModel(env);
  const prompt = buildJudgePrompt(summary, jev);

  const reply = await env.AI.run(model, {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    max_tokens: MAX_VERDICT_TOKENS,
    temperature: JUDGE_TEMPERATURE,
  });

  return { verdict: parseVerdict(replyText(reply)), model, prompt };
}
