import { QUESTIONS } from "./questions";

/**
 * Build the one request body System One is asked per packet.
 *
 * All five questions go in a single call because the PRD states the answers are
 * independent, which is exactly what makes batching safe. A per-question loop
 * would multiply latency and spend for no accuracy gain, and it would give the
 * workflow five failure points where one is enough.
 *
 * Nothing here talks to the network: this module owns the shape of the body and
 * the rules about what may go in it, and the client owns sending it. That seam
 * is what lets the body be tested without a fetch, a key, or a fixture server.
 */

/** Plain JSON, because the body is handed to `fetch` and no SDK is involved. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The compact packet summary the summarize step produces.
 *
 * Structural on purpose: the summarize step is free to change what it puts in
 * the summary without this module changing with it, and the judge never sends a
 * raw OpenTelemetry tree here no matter what the producer had lying around.
 */
export type SystemOneState = { readonly [key: string]: JsonValue };

/**
 * The model asked when nothing has been pinned.
 *
 * `jev-latest` is the exploring position. Once the question set stops moving the
 * pin goes to a fixed version, and because the pin is read from a var that is a
 * configuration change rather than a deploy of new code.
 */
export const DEFAULT_JEV_MODEL = "jev-latest";

/**
 * The single var this module reads, declared structurally.
 *
 * The Worker `Env` satisfies it, and so does a bare object in a test, so nothing
 * has to stand up a Worker to ask what model would be used.
 */
export interface JevEnv {
  readonly JEV_MODEL?: string;
}

/**
 * The ceiling on the serialised state, in bytes.
 *
 * 8 KiB. The summary is a handful of numbers, a few span names, and at most a
 * short list of labels; anything an order of magnitude past that is a summarize
 * bug, and it should surface here — where the offending field is still in hand —
 * rather than as an opaque rejection from the API.
 */
export const MAX_STATE_BYTES = 8192;

/**
 * Why a body could not be built.
 *
 * Both reasons are bugs on this side of the wire rather than producer mistakes,
 * which is why they are thrown rather than returned the way packet validation
 * returns its failures.
 */
export type SystemOneRequestErrorCode = "state_too_large" | "question_without_choices";

/** A body that was refused before it could be sent, carrying which rule refused it. */
export class SystemOneRequestError extends Error {
  readonly code: SystemOneRequestErrorCode;

  constructor(code: SystemOneRequestErrorCode, message: string) {
    super(message);
    this.name = "SystemOneRequestError";
    this.code = code;
  }
}

/**
 * The body of `POST /v1/systemone`.
 *
 * There is deliberately no streaming field of any kind: the judge wants whole
 * distributions to store and hand to System Two, and a field left out is one
 * fewer thing a future default can flip on.
 */
/** One choice option name mapped to an optional rubric description. */
export type ChoiceCriteria = Readonly<Record<string, string | null>>;

/**
 * Wire shape for one System One question (TypeSafe `/v1/systemone`).
 *
 * Discriminated on `type`. Choice questions carry `criteria` as a dictionary of
 * option ? description (not a `choices` array). The field name is `instructions`,
 * not `text`.
 */
export type SystemOneWireQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: ChoiceCriteria;
    }
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly yes?: string | null; readonly no?: string | null };
    };

export interface SystemOneRequestBody {
  model: string;
  state: SystemOneState;
  /**
   * Dictionary keyed by question id. An array produces HTTP 422 `dict_type`.
   */
  questions: Readonly<Record<string, SystemOneWireQuestion>>;
}

/**
 * Which model this deployment asks, preferring the pin over the default.
 *
 * An unset or blank var falls back rather than travelling as the string
 * "undefined", which is the shape this mistake otherwise takes: a body that
 * looks well-formed and names a model nobody ever configured.
 */
export function jevModel(env: JevEnv): string {
  const pinned = env.JEV_MODEL?.trim();
  return pinned ? pinned : DEFAULT_JEV_MODEL;
}

/**
 * Assemble the one request carrying every question and the compact state.
 *
 * The size check counts encoded bytes rather than string length, because a
 * summary holding a service name in any non-Latin script is longer on the wire
 * than it looks in memory, and the cap is a wire cap.
 */
export function buildSystemOneRequest(state: SystemOneState, env: JevEnv): SystemOneRequestBody {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > MAX_STATE_BYTES) {
    throw new SystemOneRequestError(
      "state_too_large",
      `state is ${bytes} bytes, over the ${MAX_STATE_BYTES} byte cap`,
    );
  }

  // Checked against the interface rather than the frozen literals so the guard
  // still means something the day a question is added with its choices missed.
  const questions: Record<string, SystemOneWireQuestion> = {};
  for (const question of QUESTIONS) {
    if (question.type === "choice") {
      const choices = question.choices ?? [];
      if (choices.length === 0) {
        throw new SystemOneRequestError(
          "question_without_choices",
          `question ${question.key} is a choice with nothing to choose from`,
        );
      }
      const criteria: Record<string, string | null> = {};
      for (const name of choices) {
        // Descriptions are optional on the wire; null keeps the option named.
        criteria[name] = null;
      }
      questions[question.key] = {
        type: "choice",
        instructions: question.text,
        criteria,
      };
      continue;
    }

    questions[question.key] = {
      type: "noul",
      instructions: question.text,
    };
  }

  return { model: jevModel(env), state, questions };
}
