import type { Packet, PacketEnv, TopSpan } from "../packet/types";

/**
 * Turn one validated packet into the small, bounded object the judge reasons over.
 *
 * Everything comparative in here is arithmetic done in TypeScript: the model is
 * asked what a change means, never what a change is. A percentage the code
 * computed is the same percentage on every replay, whereas a percentage a model
 * computed is a new opinion each time, and a judge whose inputs move cannot be
 * held to its own history.
 *
 * The module is pure and imports nothing but the packet contract. It talks to no
 * model, touches no storage, and takes no clock, which is what lets the workflow
 * retry the summarize step as often as it likes and lets the tests assert exact
 * numbers instead of ranges.
 */

/** The ceiling on the serialised summary, in bytes, measured on UTF-8 JSON. */
export const MAX_SUMMARY_BYTES = 4096;

/** How many error-bearing spans survive into the summary before any reduction. */
export const MAX_TOP_ERROR_SPANS = 3;

/**
 * How many code points of a span name and of a log snippet are kept.
 *
 * The packet validator caps how many spans and snippets arrive but not how long
 * a single one may be, so the only thing standing between a chatty exporter and
 * the byte cap is this. Both limits count code points rather than UTF-16 units
 * so a name ending in an astral character is cut between characters instead of
 * through a surrogate pair, which would leave the JSON holding half a symbol.
 */
export const MAX_SPAN_NAME_CHARS = 120;
export const MAX_LOG_SNIPPET_CHARS = 200;

/** How many snippets the digest joins; the third onwards is repetition of the first two. */
export const LOG_DIGEST_SNIPPETS = 2;

/** What the reduction ladder keeps when it reaches the labels. */
export const LADDER_ALERT_LABELS = 5;

/**
 * The shortest window the summary will report.
 *
 * A window is always strictly positive by the time a packet validates, but one
 * measured in seconds rounds to zero at one decimal place, and a zero-length
 * window invites the judge to read every rate in the packet as meaningless.
 * Reporting a floor says "very short" where a zero would say "impossible".
 */
export const MIN_WINDOW_MINUTES = 0.1;

/**
 * One error-bearing span, reduced to what a judge can act on.
 *
 * `error_share` is what makes the entry worth its bytes: a span with 90 errors
 * is a different fact depending on whether the packet holds 100 errors or
 * 100,000, and the share answers that without the judge doing arithmetic.
 */
export type TopErrorSpan = {
  name: string;
  count: number;
  error_count: number;
  error_share: number;
};

/**
 * Everything System One is told about one incident window.
 *
 * Declared as a type alias rather than an interface on purpose: the request
 * builder takes a structural `{ [key: string]: JsonValue }`, and TypeScript only
 * infers an implicit index signature for an alias. An interface here would
 * compile fine on its own and then refuse to be passed to the one function this
 * type exists to be passed to.
 *
 * Every field is always present. An absent measurement is `null` rather than a
 * missing key, because a judge reading a fixed shape can tell "not measured"
 * from "measured at zero", while a judge reading whatever keys happened to
 * survive has to guess.
 */
export type PacketSummary = {
  packet_id: string;
  service: string;
  env: PacketEnv;
  window_minutes: number;
  error_rate: number;
  error_rate_baseline: number;
  error_rate_delta_pct: number | null;
  p95_latency_ms: number;
  p95_latency_baseline_ms: number;
  p95_latency_delta_pct: number | null;
  request_rate_rps: number;
  slo_burn_rate: number;
  saturation_peak_pct: number | null;
  queue_depth: number | null;
  deploy_minutes_ago: number | null;
  deploy_version: string | null;
  top_error_spans: TopErrorSpan[];
  alert_labels: string[];
  log_digest: string;
  baseline_missing: boolean;
};

/**
 * Raised when even the fully reduced summary is over the cap.
 *
 * Thrown rather than returned, and thrown rather than truncated: a summary cut
 * mid-structure is not smaller information, it is different information, and the
 * model would read it as fact without any sign that a field went missing. The
 * byte count travels with the error so the step that catches it can say how far
 * over the packet was instead of only that it was.
 */
export class SummaryTooLargeError extends Error {
  readonly packetId: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(packetId: string, bytes: number) {
    super(
      `summary for packet ${packetId} is ${bytes} bytes after the full reduction ladder, over the ${MAX_SUMMARY_BYTES} byte cap`,
    );
    this.name = "SummaryTooLargeError";
    this.packetId = packetId;
    this.bytes = bytes;
    this.limit = MAX_SUMMARY_BYTES;
  }
}

/**
 * Round half up to a fixed number of decimals, with negative zero flattened.
 *
 * `Math.round` answers `-0` for any small negative input, and `-0` is a value
 * that prints as `0`, compares equal to `0` under `===`, and is not `0` under
 * `Object.is`. Flattening it here keeps the promise that the same packet
 * summarises to the same bytes and spares every later assertion from the
 * distinction.
 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * How far a measurement has moved from its baseline, as a percentage.
 *
 * A baseline of zero is the cold-start case rather than an error: a service with
 * no errors last week and errors now has moved infinitely far in ratio terms and
 * not usefully far in any way a percentage can carry. That answer is `null`, and
 * the caller turns `null` into the `baseline_missing` flag, so the judge is told
 * the comparison was unavailable rather than being handed a zero that reads as
 * "nothing changed".
 */
export function pctDelta(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;

  const delta = ((current - baseline) / baseline) * 100;
  return Number.isFinite(delta) ? roundTo(delta, 1) : null;
}

/** Cut to a length in code points, so a surrogate pair is never split in half. */
function truncateCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** The encoded size of the summary as it would travel, which is the only size the cap means. */
function summaryBytes(summary: PacketSummary): number {
  return new TextEncoder().encode(JSON.stringify(summary)).byteLength;
}

/**
 * The spans worth naming, which are the ones carrying errors.
 *
 * Ranking is by error count rather than by traffic: the busiest span in a
 * healthy dependency is exactly the span a judge should not be looking at, and a
 * span with no errors at all is dropped however much traffic it carries. Ties
 * break on the name so the ordering is a property of the content rather than of
 * whichever order the exporter happened to serialise its spans in.
 */
function topErrorSpans(spans: readonly TopSpan[]): TopErrorSpan[] {
  // The denominator is every span's errors, including the spans about to be
  // dropped, because a share is only honest against the whole packet.
  const total = spans.reduce((sum, span) => sum + span.error_count, 0);

  return spans
    .filter((span) => span.error_count > 0)
    .sort((a, b) => b.error_count - a.error_count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_TOP_ERROR_SPANS)
    .map((span) => ({
      name: truncateCodePoints(span.name, MAX_SPAN_NAME_CHARS),
      count: span.count,
      error_count: span.error_count,
      // Guarded even though a zero total means this array is empty: the guard
      // costs nothing and a division that can produce NaN would put a value in
      // the summary that JSON turns into `null` without anyone noticing.
      error_share: total > 0 ? roundTo(span.error_count / total, 2) : 0,
    }));
}

/** The highest resource pressure the producer measured, or nothing if it measured none. */
function saturationPeak(packet: Packet): number | null {
  const measured = [packet.signals.saturation?.cpu_pct, packet.signals.saturation?.mem_pct].filter(
    (value): value is number => value !== undefined,
  );
  return measured.length > 0 ? Math.max(...measured) : null;
}

/** How long the window ran, never reported as zero. */
function windowMinutes(packet: Packet): number {
  const minutes = (Date.parse(packet.window.end) - Date.parse(packet.window.start)) / 60_000;
  if (!Number.isFinite(minutes)) return MIN_WINDOW_MINUTES;
  return Math.max(MIN_WINDOW_MINUTES, roundTo(minutes, 1));
}

/**
 * The first couple of log lines, each cut short.
 *
 * Absent snippets give an empty string rather than a null so the field is always
 * the same type, which is also what lets the first rung of the reduction ladder
 * empty it without changing the shape the judge was calibrated on.
 */
function logDigest(packet: Packet): string {
  return (packet.log_snippets ?? [])
    .slice(0, LOG_DIGEST_SNIPPETS)
    .map((snippet) => truncateCodePoints(snippet, MAX_LOG_SNIPPET_CHARS))
    .join("\n");
}

/**
 * The order fields are given up in when the summary is over the cap.
 *
 * Least load-bearing first. Log lines are colour, a second and third error span
 * are corroboration of the first, and alert labels past the fifth are usually
 * the same incident spelled several ways. Nothing in the ladder touches a
 * measurement or a baseline: those are why the packet was sent.
 */
const REDUCTIONS: readonly ((summary: PacketSummary) => PacketSummary)[] = [
  (summary) => ({ ...summary, log_digest: "" }),
  (summary) => ({ ...summary, top_error_spans: summary.top_error_spans.slice(0, 1) }),
  (summary) => ({ ...summary, alert_labels: summary.alert_labels.slice(0, LADDER_ALERT_LABELS) }),
];

/** Walk the ladder only as far as the cap requires, then refuse rather than cut. */
function fitToCap(summary: PacketSummary): PacketSummary {
  let fitted = summary;

  for (const reduce of REDUCTIONS) {
    if (summaryBytes(fitted) <= MAX_SUMMARY_BYTES) return fitted;
    fitted = reduce(fitted);
  }

  const bytes = summaryBytes(fitted);
  if (bytes > MAX_SUMMARY_BYTES) throw new SummaryTooLargeError(fitted.packet_id, bytes);
  return fitted;
}

/**
 * Summarise one packet, or refuse to summarise it at all.
 *
 * Exemplar trace ids are deliberately absent from the result. They are opaque
 * identifiers: they carry nothing a probabilistic judge can reason from, they
 * cost budget in every prompt they appear in, and they remain in SQL for a human
 * to pivot on, which is the only place they were ever useful.
 *
 * Pure and deterministic — the same packet produces byte-identical output — so a
 * durable workflow step wrapping this call can be retried without the retry
 * changing what the judge is later asked about.
 */
export function summarizePacket(packet: Packet): PacketSummary {
  const errorRateDelta = pctDelta(packet.signals.error_rate, packet.signals.error_rate_baseline);
  const latencyDelta = pctDelta(
    packet.signals.p95_latency_ms,
    packet.signals.p95_latency_baseline_ms,
  );

  return fitToCap({
    packet_id: packet.packet_id,
    service: packet.service,
    env: packet.env,
    window_minutes: windowMinutes(packet),
    error_rate: packet.signals.error_rate,
    error_rate_baseline: packet.signals.error_rate_baseline,
    error_rate_delta_pct: errorRateDelta,
    p95_latency_ms: packet.signals.p95_latency_ms,
    p95_latency_baseline_ms: packet.signals.p95_latency_baseline_ms,
    p95_latency_delta_pct: latencyDelta,
    request_rate_rps: packet.signals.request_rate_rps,
    slo_burn_rate: packet.signals.slo_burn_rate,
    saturation_peak_pct: saturationPeak(packet),
    // Passed through rather than scaled: a queue depth is a count of waiting
    // work, and there is no baseline in the packet to read it against.
    queue_depth: packet.signals.saturation?.queue_depth ?? null,
    deploy_minutes_ago: packet.recent_deploy?.minutes_ago ?? null,
    deploy_version: packet.recent_deploy?.version ?? null,
    top_error_spans: topErrorSpans(packet.top_spans),
    alert_labels: [...packet.alert_labels],
    log_digest: logDigest(packet),
    // One unavailable comparison is enough: the judge needs to know that some
    // part of the "versus normal" story is missing, and the null field itself
    // says which part.
    baseline_missing: errorRateDelta === null || latencyDelta === null,
  });
}
