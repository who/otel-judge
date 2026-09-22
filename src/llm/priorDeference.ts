import type { JevResult } from "../jev/types";
import type { Verdict, VerdictSeverity } from "./judge";

/**
 * The one place a prior's number decides anything, and it decides it afterwards.
 *
 * System One is calibrated on the question "is this noise?" and System Two is
 * not. A summary carrying a 500 and a latency spike reads alarming in prose
 * whether or not the window is a chaos experiment, so the judge grades the
 * window sev1 while the priors sit at 0.99 noise, and the board paints a flag
 * nobody wants. The rule below is the cheapest correction that does not cost the
 * judge its voice: when the priors are overwhelmingly noise and the judge has
 * not said it disagrees with them, the severity defers to theirs.
 *
 * What it deliberately is not: a gate. The judge is still asked, still answers
 * in full, and still outranks the priors whenever it claims the disagreement the
 * prompt asks it to claim. Deference applies to a verdict that graded an
 * incident while agreeing with a noise prior — a self-contradiction only one of
 * the two can win, and the calibrated model wins it.
 */

/**
 * The noise mass at which the priors outweigh an undisputed incident grade.
 *
 * Seven tenths rather than a bare majority: at 0.5 a genuinely split prior would
 * start overruling the judge, and the condition this exists for is not a split
 * prior but a lopsided one. Compared with `>=` so the threshold names a value
 * that defers rather than the first value above it.
 */
export const NOISE_MAJORITY_THRESHOLD = 0.7;

/**
 * Where each question keeps its "this is noise" mass.
 *
 * `severity` is a choice question and carries `noise` in its closed set outright.
 * `noise_likely` is a noul question, which the System One parser publishes as a
 * yes/no distribution around the calibrated yes-mass, so its affirmative outcome
 * is `yes`. Every other question answers something else entirely and is read by
 * nothing here — a deploy-related prior is not evidence about noise.
 */
const NOISE_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  severity: "noise",
  noise_likely: "yes",
});

/** The grades that can be deferred: an incident called over a noise prior. */
const INCIDENT_SEVERITIES: readonly VerdictSeverity[] = Object.freeze([
  "sev0",
  "sev1",
  "sev2",
] as const);

/**
 * The strongest claim the priors make that this window is noise.
 *
 * The maximum rather than a sum or an average, because the two questions are two
 * readings of one fact and adding them would double-count agreement while
 * averaging them would let a question System One answered flatly talk a
 * confident one down. A run that produced no priors at all claims nothing, which
 * is zero.
 */
export function noiseMass(jev: JevResult): number {
  if (!jev.ok) return 0;

  let strongest = 0;
  for (const answer of jev.answers) {
    const outcome = NOISE_OUTCOMES[answer.key];
    if (outcome === undefined) continue;

    const mass = answer.distribution[outcome];
    if (typeof mass !== "number" || !Number.isFinite(mass)) continue;
    if (mass > strongest) strongest = mass;
  }
  return strongest;
}

/** Whether the priors are lopsidedly noise by the threshold above. */
export function isNoiseMajority(
  jev: JevResult,
  threshold: number = NOISE_MAJORITY_THRESHOLD,
): boolean {
  return noiseMass(jev) >= threshold;
}

/** Say in the critique that the grade below it is not the one the judge wrote. */
function deferenceNote(graded: VerdictSeverity, mass: number): string {
  return (
    `Severity deferred to System One: this verdict graded ${graded} while the priors put ` +
    `${mass} on noise and it claimed no disagreement with them.`
  );
}

function withNote(critique: string, note: string): string {
  const existing = critique.trim();
  return existing === "" ? note : `${existing} ${note}`;
}

/**
 * The verdict as it should be stored, deferred to the priors where it must be.
 *
 * Returns the verdict it was given, unchanged and identical, in every case but
 * the one this module exists for: an incident grade, no declared disagreement,
 * and noise-majority priors. `raw` is never touched — it is what the model said,
 * and the coercion is this repository's, not the model's — so the reasoning
 * trail still shows the grade that was written and the critique now says why the
 * severity beside it reads differently.
 *
 * An `unknown` severity is left alone rather than swept into noise. A judge that
 * could not grade the window has not agreed with the priors about it, and
 * inventing agreement would put a verdict in history that nobody reached.
 */
export function applyPriorDeference(verdict: Verdict, jev: JevResult): Verdict {
  if (verdict.disagrees_with_prior) return verdict;
  if (!INCIDENT_SEVERITIES.includes(verdict.severity)) return verdict;

  const mass = noiseMass(jev);
  if (mass < NOISE_MAJORITY_THRESHOLD) return verdict;

  return {
    ...verdict,
    severity: "noise",
    critique: withNote(verdict.critique, deferenceNote(verdict.severity, mass)),
  };
}
