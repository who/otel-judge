/**
 * The questions the judge asks System One, frozen as data rather than prose.
 *
 * System One answers narrow questions and never writes narrative, so the whole
 * of what it is asked fits in one table. Keeping that table here — instead of
 * assembling it wherever a request happens to be sent — is what makes the set
 * reviewable: a reader can see every question the judge has ever asked without
 * reading the transport, and a reviewer can tell at a glance that nothing is
 * being asked of the model that the stored history cannot explain later.
 *
 * The keys are durable identifiers. They are written into the
 * `jev_answers.question_key` column and rendered by the demo channel, so adding
 * a question is additive but renaming or removing one strands every answer
 * already stored under the old name.
 */

/**
 * The two answer shapes System One returns.
 *
 * `choice` picks from a closed set; `noul` is the model's own graded scale and
 * carries no choices of its own, which is why the choices field is optional
 * rather than an empty array on half the rows.
 */
export type SystemOneQuestionType = "choice" | "noul";

/** How bad this is, from a page-now outage down to something not worth a ticket. */
export const SEVERITY_CHOICES = Object.freeze(["sev0", "sev1", "sev2", "noise"] as const);

/**
 * The families a first responder would actually triage into.
 *
 * `unknown` is a real answer, not a gap: forcing a guess between four causes
 * that all look wrong is how a distribution stops meaning anything.
 */
export const ROOT_CAUSE_CHOICES = Object.freeze([
  "deploy_regression",
  "dependency",
  "saturation",
  "bad_config",
  "unknown",
] as const);

/**
 * One question, carrying the text alongside the key.
 *
 * The wording travels with the answer so stored history explains what was
 * asked, not merely what came back. An answer to "is this noise?" read a year
 * later is worth very little if the question it answered has since been reworded.
 */
export interface SystemOneQuestion {
  key: string;
  type: SystemOneQuestionType;
  text: string;
  /** Only choice questions carry one; a noul question has no closed set to offer. */
  choices?: readonly string[];
}

/**
 * The MVP question set, in the order it is always sent.
 *
 * Order is part of the contract rather than an accident of authoring: stored
 * history and replay comparisons line up positionally, so sorting this array or
 * appending in the middle would quietly change what two runs mean side by side.
 * `as const` freezes it for the compiler and `Object.freeze` for the runtime,
 * because a shared constant that anything may splice is not a contract.
 *
 * The literal table stays private so `QuestionKey` can go on being derived from
 * it. What every consumer reads is `QUESTIONS` below, the same frozen array
 * declared as the interface.
 */
const QUESTION_TABLE = Object.freeze([
  {
    key: "severity",
    type: "choice",
    text: "How severe is this incident?",
    choices: SEVERITY_CHOICES,
  },
  {
    key: "needs_human",
    type: "noul",
    text: "Would an SRE want eyes on this now?",
  },
  {
    key: "deploy_related",
    type: "noul",
    text: "Is this incident related to a recent deploy?",
  },
  {
    key: "noise_likely",
    type: "noul",
    text: "Is this alert most likely noise rather than a real incident?",
  },
  {
    key: "root_cause_family",
    type: "choice",
    text: "Which family does the most likely root cause belong to?",
    choices: ROOT_CAUSE_CHOICES,
  },
] as const) satisfies readonly SystemOneQuestion[];

/**
 * The question set as the rest of the judge sees it: the interface, not the
 * literals that happen to satisfy it today.
 *
 * The declared type is what keeps the empty-choices guard in
 * `buildSystemOneRequest` honest. Inferred from the table, `choices.length` is
 * `4 | 5`, and a guard asking whether it is zero is a comparison the compiler
 * can prove will never be true — an argument about the five questions authored
 * so far rather than about the contract the guard exists to defend. Declaring
 * the interface widens that length back to `number`, so the day a sixth
 * question is added with its choices missed, the guard is still reachable code
 * and still throws.
 */
export const QUESTIONS: readonly SystemOneQuestion[] = QUESTION_TABLE;

/**
 * Every key that may ever appear in an answer, derived from the map itself.
 *
 * Deriving rather than declaring means a question added below is a question the
 * compiler immediately demands every downstream switch handle, instead of one
 * that silently falls through a default branch nobody revisits.
 */
export type QuestionKey = (typeof QUESTION_TABLE)[number]["key"];
