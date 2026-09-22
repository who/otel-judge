/**
 * Which Llama this deployment asks, and where that choice is written down.
 *
 * The model id is a documented claim: the README names it, the verdict quality
 * the fixtures were written against came from it, and a stored verdict records
 * which model produced it. Keeping the id in one exported constant — rather than
 * inline at the call site — is what lets a reader answer "which model judged
 * this?" without reading the invocation, and what makes re-pinning a one-line
 * change reviewed on its own.
 */

/**
 * The pinned Workers AI model.
 *
 * Instruction-tuned, fast enough that a judgement lands while an incident is
 * still an incident, and large enough to reason about a distribution rather than
 * echo its argmax. The fp8 variant is the pin rather than an implementation
 * detail: the quantisation is part of what the latency budget assumes.
 */
export const DEFAULT_LLAMA_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * What the judge reads from the environment.
 *
 * Structural rather than the generated `Env`, so a test can call this with an
 * object literal and so the module stays honest about the single var it reads.
 */
export interface LlamaEnv {
  readonly LLAMA_MODEL?: string;
}

/**
 * The model this deployment asks, preferring the var over the pin.
 *
 * Re-pinning is then a deploy-time change rather than a code change, which is
 * what a model deprecation notice actually needs from an operator. An unset or
 * blank var falls back instead of travelling as the string "undefined": a
 * request naming a model nobody configured fails in a way that looks like the
 * model's fault rather than the configuration's.
 */
export function llamaModel(env: LlamaEnv): string {
  const pinned = env.LLAMA_MODEL?.trim();
  return pinned ? pinned : DEFAULT_LLAMA_MODEL;
}
