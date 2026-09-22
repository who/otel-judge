import type { QuestionKey } from "./questions";

/**
 * What a System One call produces, as types alone.
 *
 * The transport and the parser both speak in these shapes, and so will the
 * storage and workflow tasks that consume them, so they live apart from either
 * implementation: a consumer that only needs to know what an answer looks like
 * should not have to import a module that knows how to reach the network.
 */

/**
 * One question's probability vector: an outcome name to the mass on it.
 *
 * This is the thing the whole diamond model turns on. The PRD requires full
 * distributions to reach System Two, so the vector is what travels and what is
 * stored; anything that collapses it to a single label is a summary of it, never
 * a replacement for it.
 */
export type JevDistribution = Readonly<Record<string, number>>;

/** The most likely outcome, computed once so every reader agrees which it is. */
export interface JevArgmax {
  outcome: string;
  p: number;
}

/**
 * One answer, whole.
 *
 * `noul` is the mass System One declined to place on any offered outcome — the
 * model's own "I do not know" — and it is carried beside the vector rather than
 * folded into it, because a question answered with most of its mass on noul is a
 * different fact from a question answered confidently and must stay legible as
 * one. `argmax` is a convenience for a reader or a display; it is additive.
 */
export interface JevAnswer {
  key: QuestionKey;
  distribution: JevDistribution;
  noul: number;
  argmax: JevArgmax;
}

/** A call that produced usable answers for every question that was asked. */
export interface JevSuccess {
  ok: true;
  answers: JevAnswer[];
  model: string;
  latency_ms: number;
}

/**
 * A call that did not, and whether trying it again could change that.
 *
 * `retryable` is the only part of this a caller has to act on, and it is decided
 * here rather than by whoever reads the reason string: a workflow step should
 * never be in the business of pattern-matching prose to work out whether to run
 * itself again. `status` is absent when nothing answered at all.
 */
export interface JevFailure {
  ok: false;
  retryable: boolean;
  reason: string;
  status?: number;
}

/**
 * The whole of what a call can return.
 *
 * A union rather than an exception, because an unreachable System One is an
 * ordinary condition in this system — the PRD says the judge continues without
 * it — and ordinary conditions belong in the return type where the compiler can
 * insist the caller handles them.
 */
export type JevResult = JevSuccess | JevFailure;
