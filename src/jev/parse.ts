import { QUESTIONS } from "./questions";
import type { JevAnswer, JevArgmax, JevDistribution } from "./types";

/**
 * Turn a System One response body into answers, or say why it is not one.
 *
 * The parser is deliberately strict and deliberately separate from the client.
 * Strict, because the one thing this system must never do is hand System Two a
 * prior nobody computed: a body that cannot be read as a full distribution is
 * refused here rather than patched up into something plausible. Separate,
 * because every rule below is then testable against a literal object, with no
 * fetch, no key, and no server standing in the way of asking what happens to a
 * vector that sums to 1.4.
 */

/**
 * How far the total mass may sit from 1 before the body is refused.
 *
 * Probabilities arrive as decimal JSON numbers that were rounded somewhere, so
 * an exact comparison would reject arithmetic rather than error. A hundredth is
 * wide enough for rounding and far too narrow to admit a vector that is missing
 * an outcome or double-counting one.
 */
export const MASS_TOLERANCE = 0.01;

/** Answers, in the frozen question order, or the first rule that was broken. */
export type ParseOutcome =
  | { ok: true; answers: JevAnswer[]; model: string | null }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(reason: string): ParseOutcome {
  return { ok: false, reason };
}

/**
 * Index whatever the body offers as answers by question key.
 *
 * Both containers are accepted — a list of answers that name their key, and a
 * map from key to answer — because which one an API returns is a presentation
 * choice, while the thing this module actually cares about is that every
 * question it asked comes back. Neither form is allowed to be implicit: an entry
 * in a list without a key is refused rather than matched by position, since
 * positional matching would silently mislabel every answer after a reordering.
 */
function indexByKey(
  answers: unknown,
): { ok: true; entries: Map<string, unknown> } | { ok: false; reason: string } {
  const entries = new Map<string, unknown>();

  if (Array.isArray(answers)) {
    for (const [index, entry] of answers.entries()) {
      if (!isRecord(entry)) return { ok: false, reason: `answers[${index}] is not an object` };
      const key = entry.key;
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false, reason: `answers[${index}] does not name a question key` };
      }
      entries.set(key, entry);
    }
    return { ok: true, entries };
  }

  if (isRecord(answers)) {
    for (const [key, entry] of Object.entries(answers)) entries.set(key, entry);
    return { ok: true, entries };
  }

  return { ok: false, reason: "answers is neither a list nor a map" };
}

/** A probability: a real number in mass terms, which rules out NaN and negatives. */
function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read one entry into an answer, or name the rule it broke.
 *
 * An absent `noul` is read as zero rather than refused, because a vector that
 * already accounts for all of its mass has left none unplaced and saying so
 * invents nothing. A present `noul` that is not a probability is a different
 * matter and is refused: that is a field the model meant to fill and did not.
 */
function readAnswer(key: string, entry: unknown): { ok: true; answer: JevAnswer } | { ok: false; reason: string } {
  if (!isRecord(entry)) return { ok: false, reason: `answer for ${key} is not an object` };

  const raw = entry.distribution;
  if (!isRecord(raw)) return { ok: false, reason: `answer for ${key} carries no distribution` };

  const outcomes = Object.entries(raw);
  if (outcomes.length === 0) return { ok: false, reason: `distribution for ${key} is empty` };

  const distribution: Record<string, number> = {};
  let mass = 0;
  let argmax: JevArgmax | null = null;
  for (const [outcome, probability] of outcomes) {
    if (!isProbability(probability)) {
      return { ok: false, reason: `probability for ${key}.${outcome} is not a probability` };
    }
    distribution[outcome] = probability;
    mass += probability;
    // Strictly greater, so a tie keeps the first outcome the model listed and
    // two reads of the same body can never disagree about which one won.
    if (argmax === null || probability > argmax.p) argmax = { outcome, p: probability };
  }

  const noul = entry.noul === undefined ? 0 : entry.noul;
  if (!isProbability(noul)) return { ok: false, reason: `noul for ${key} is not a probability` };

  const total = mass + noul;
  if (Math.abs(total - 1) > MASS_TOLERANCE) {
    // The budget is the whole of the model's belief: a vector that sums to 1
    // beside a positive noul has claimed more than all of it, and one that sums
    // short has lost some. Either way the numbers do not describe a belief, and
    // retrying cannot make them.
    return { ok: false, reason: `mass for ${key} sums to ${total}, not 1` };
  }

  // Non-null by construction: the empty check above guarantees at least one pass.
  return {
    ok: true,
    answer: { key: key as JevAnswer["key"], distribution: distribution as JevDistribution, noul, argmax: argmax as JevArgmax },
  };
}

/**
 * Read a whole response, refusing anything short of every question answered.
 *
 * Coverage is checked against the frozen question map rather than against
 * whatever came back, so a body that answers four of five is malformed even
 * though nothing in it is individually wrong — a missing answer is the one
 * failure that would otherwise pass quietly and leave System Two reasoning over
 * a gap. Answers come back in question order for the same reason the questions
 * are frozen in one: stored history and replays line up.
 */
export function parseSystemOneResponse(json: unknown): ParseOutcome {
  if (!isRecord(json)) return malformed("response body is not a JSON object");

  const indexed = indexByKey(json.answers);
  if (!indexed.ok) return malformed(indexed.reason);

  const answers: JevAnswer[] = [];
  for (const question of QUESTIONS) {
    const entry = indexed.entries.get(question.key);
    if (entry === undefined) return malformed(`no answer for ${question.key}`);

    const read = readAnswer(question.key, entry);
    if (!read.ok) return malformed(read.reason);
    answers.push(read.answer);
  }

  const model = typeof json.model === "string" && json.model.length > 0 ? json.model : null;
  return { ok: true, answers, model };
}
