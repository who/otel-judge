import { SEVERITY_CHOICES } from "../jev/questions";
import type { Verdict, VerdictSeverity } from "./judge";

/**
 * Turn whatever the judge said into a verdict, whatever it said.
 *
 * This module never throws and never returns a failure for the caller to
 * branch on. A packet is durable and acknowledged long before the judge is
 * asked, and a model that answered badly is not a reason to lose the packet's
 * outcome: an unreadable reply becomes an unknown-severity verdict carrying the
 * raw text, which is a fact a human can act on, while an exception here would be
 * a failed evaluation of a packet the model in fact answered.
 *
 * Separate from the invocation so every rule below is testable against a string
 * literal, with no binding, no account entitlement and no model in the way of
 * asking what happens to a reply with two JSON objects in it.
 */

/** What a reply that could not be read becomes, before the raw text is attached. */
const UNREADABLE: Omit<Verdict, "raw"> = {
  severity: "unknown",
  summary: "",
  critique: "",
  next_action: "",
  confidence_note: "",
  disagrees_with_prior: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first JSON object in the text, ignoring everything around it.
 *
 * Scanning for balanced braces rather than matching a regular expression is what
 * makes a fenced reply, a reply with a sentence of preamble, and a reply with a
 * second object after the first all read the same way. The scan is deliberately
 * first-wins: a greedy match to the last closing brace would splice a worked
 * example and the real answer into one unparseable blob, and a judge that
 * thought out loud before answering would lose its answer.
 *
 * Braces inside strings are skipped, because a critique naming a JSON field is
 * ordinary prose and must not close the object early.
 */
function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
      const character = text[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') inString = true;
      else if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (depth > 0) continue;
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          // Balanced but not JSON — prose in braces, or a near-miss object with
          // a trailing comma. Give up on this candidate and look for the next
          // opening brace rather than on the reply as a whole.
          break;
        }
      }
    }
  }

  return undefined;
}

/**
 * Keep a severity only if it is one of the grades that exist.
 *
 * A model asked for one of four words occasionally answers with a fifth, and the
 * one thing that must not happen is that word being stored as though it were a
 * grade: every later reader — the channel, a replay, a human scanning history —
 * would have to decide for itself what "critical" ranks against `sev1`.
 * `unknown` says the judge did not grade this, which is true.
 */
function normalizeSeverity(value: unknown): VerdictSeverity {
  for (const choice of SEVERITY_CHOICES) {
    if (value === choice) return choice;
  }
  return "unknown";
}

/** A prose field, or the empty string when the model left it out or sent something else. */
function prose(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read one reply into a verdict, degrading rather than failing.
 *
 * `disagrees_with_prior` is true only when the model said so. Anything else —
 * absent, a string, a number — is read as no claim of disagreement, because this
 * flag is displayed as a fact about the judgement and a coerced truthy value
 * would put a disagreement in the record that nobody ever expressed.
 *
 * The raw text is attached to every verdict, not only to the ones that failed to
 * parse: it is what the reasoning trail is made of, and the fields above it are
 * a reading of it rather than a replacement for it.
 */
export function parseVerdict(text: string): Verdict {
  const object = firstJsonObject(text);
  if (!isRecord(object)) return { ...UNREADABLE, raw: text };

  return {
    severity: normalizeSeverity(object.severity),
    summary: prose(object.summary),
    critique: prose(object.critique),
    next_action: prose(object.next_action),
    confidence_note: prose(object.confidence_note),
    disagrees_with_prior: object.disagrees_with_prior === true,
    raw: text,
  };
}
