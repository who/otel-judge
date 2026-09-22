/**
 * The version of the packet contract this repository implements.
 *
 * This number is the seam between the producer repository and the judge. Adding
 * an optional field does not move it; renaming a field, changing its type, or
 * making an optional field required does. A packet carrying any other version is
 * rejected rather than parsed on a best-effort basis, because a producer that
 * guesses wrong should learn immediately instead of having half its telemetry
 * silently reinterpreted. Stored packets keep the version they arrived with.
 */
export const PACKET_SCHEMA_VERSION = 1;

/** The three deployment environments a packet may describe. */
export type PacketEnv = "prod" | "staging" | "dev";

/** The closed time range the signals were measured over, both ends in UTC. */
export interface PacketWindow {
  start: string;
  end: string;
}

/** Resource pressure, all optional: plenty of producers cannot measure any of it. */
export interface PacketSaturation {
  cpu_pct?: number;
  mem_pct?: number;
  queue_depth?: number;
}

/**
 * The measurements the judge reasons over, each paired with its baseline where
 * one exists, so a rate is always readable against what normal looked like.
 */
export interface PacketSignals {
  error_rate: number;
  error_rate_baseline: number;
  p95_latency_ms: number;
  p95_latency_baseline_ms: number;
  request_rate_rps: number;
  slo_burn_rate: number;
  saturation?: PacketSaturation;
}

/** One hot span, already aggregated by the producer. */
export interface TopSpan {
  name: string;
  count: number;
  error_count: number;
  p95_ms: number;
}

/** The deploy a human would suspect first, when the producer knows of one. */
export interface RecentDeploy {
  version: string;
  deployed_at: string;
  minutes_ago: number;
}

/**
 * Everything the judge is ever given about one incident window.
 *
 * Deliberately small and already summarized: a raw OpenTelemetry tree is an
 * unbounded thing that no model should be handed, so the producer does the
 * aggregation and sends this instead. Every array is capped by the validator,
 * which is what makes the whole packet bounded rather than merely well-shaped.
 */
export interface Packet {
  schema_version: number;
  packet_id: string;
  service: string;
  env: PacketEnv;
  window: PacketWindow;
  signals: PacketSignals;
  top_spans: TopSpan[];
  exemplar_trace_ids: string[];
  alert_labels: string[];
  recent_deploy?: RecentDeploy;
  log_snippets?: string[];
}
