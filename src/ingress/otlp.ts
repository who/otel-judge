import { agentNameForPacket } from "../agent/identity";
import { PACKET_SCHEMA_VERSION, type Packet, type PacketEnv, type PacketWindow } from "../packet/types";
import { validatePacket } from "../packet/validate";
import { jsonError } from "../worker/errors";
import { forwardToAgent } from "./forward";
import { readVerifiedBody, type IngestEnv } from "./ingest";

/**
 * The OTLP/JSON dialect of the front door.
 *
 * A collector speaks metrics, not packets, so something has to translate. That
 * something lives here rather than in the Agent: this file and its route are
 * the concrete channel-specific code the portability claim is about, and
 * deleting both leaves the judge and the normalized `/ingest` route untouched.
 * Nothing under `src/agent/` may import it, and nothing here reaches back.
 *
 * Translation refuses rather than guesses. Every derivation below either finds
 * what it needs in the export or answers with an `AdapterError` naming the
 * field, because a packet assembled from assumed baselines or an assumed
 * environment reads exactly like a real one and would be judged as one.
 */

/** The stable path a collector is pointed at; changing it is a two-repository change. */
export const OTLP_INGEST_PATH = "/ingest/otlp";

/** Where the request counter and the duration histogram are looked for by default. */
const DEFAULT_REQUEST_METRIC = "http.server.request.count";
const DEFAULT_DURATION_METRIC = "http.server.request.duration";

const SERVICE_ATTRIBUTE = "service.name";
const ENVIRONMENT_ATTRIBUTE = "deployment.environment";

/** A data point carrying this attribute counts as failed traffic; its absence is success. */
const ERROR_ATTRIBUTE = "error.type";

/** The percentile the packet contract asks for, expressed once. */
const PERCENTILE = 0.95;

/** Hex characters kept from the digest. Frozen: stored packet ids were derived with it. */
const PACKET_ID_LENGTH = 32;

/** How much of a producer-supplied value an error message is allowed to quote back. */
const MAX_ECHO_LENGTH = 48;

/**
 * Only delta temporality is read. A cumulative counter measures since process
 * start rather than since the window opened, so dividing it by the window would
 * report a rate that silently falls as the process ages.
 */
const DELTA_TEMPORALITY: readonly unknown[] = [1, "AGGREGATION_TEMPORALITY_DELTA"];

/** The environment spellings a collector actually emits, mapped onto the three the contract allows. */
const ENVIRONMENTS: Record<string, PacketEnv | undefined> = {
  prod: "prod",
  production: "prod",
  staging: "staging",
  stage: "staging",
  dev: "dev",
  development: "dev",
};

/** Duration units the histogram may be reported in, and what turns them into milliseconds. */
const DURATION_SCALE: Record<string, number | undefined> = { ms: 1, s: 1000 };

/** An OTLP attribute value, of which only the two scalar forms are read. */
interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key?: string;
  value?: OtlpAnyValue;
}

interface OtlpDataPoint {
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  attributes?: OtlpAttribute[];
}

interface OtlpNumberDataPoint extends OtlpDataPoint {
  asInt?: string | number;
  asDouble?: number;
}

interface OtlpHistogramDataPoint extends OtlpDataPoint {
  count?: string | number;
  sum?: number;
  bucketCounts?: (string | number)[];
  explicitBounds?: number[];
}

interface OtlpSum {
  aggregationTemporality?: number | string;
  isMonotonic?: boolean;
  dataPoints?: OtlpNumberDataPoint[];
}

interface OtlpHistogram {
  aggregationTemporality?: number | string;
  dataPoints?: OtlpHistogramDataPoint[];
}

interface OtlpMetric {
  name?: string;
  unit?: string;
  sum?: OtlpSum;
  histogram?: OtlpHistogram;
}

interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpAttribute[] };
  scopeMetrics?: { metrics?: OtlpMetric[] }[];
}

/**
 * What a collector posts to the OTLP route.
 *
 * An OTLP `ExportMetricsServiceRequest` plus one field the protocol has no
 * place for: a single export says what is happening now and nothing about what
 * normal looks like, and every delta the judge reasons over is measured against
 * normal. The producer knows its baselines; the adapter refuses to invent them.
 */
export interface OtlpIngestBody {
  resourceMetrics?: OtlpResourceMetrics[];
  baselines?: {
    error_rate: number;
    p95_latency_ms: number;
    slo_burn_rate?: number;
  };
}

/** Which metrics carry the two signals, for a producer whose names differ from the defaults. */
export interface OtlpAdapterOptions {
  requestMetric?: string;
  durationMetric?: string;
}

/**
 * A translation that could not be completed, returned rather than thrown.
 *
 * An export the adapter cannot read is an ordinary outcome — collectors are
 * other people's programs — so the failure is a value the route renders. The
 * `code` is the machine token a producer branches on and is part of the wire
 * contract; the message names the field that was missing or wrong and never
 * suggests what the adapter would have assumed, because there is no assumption.
 */
export class AdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** Quote a producer-supplied value back without letting it run away with the message. */
function echo(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return JSON.stringify(
    text.length > MAX_ECHO_LENGTH ? `${text.slice(0, MAX_ECHO_LENGTH)}…` : text,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Read a 64-bit OTLP integer.
 *
 * The protocol's JSON mapping writes 64-bit fields as strings precisely because
 * a double cannot hold them, so the string form is parsed as a `bigint` and the
 * number form is accepted only while it is still exact.
 */
function integerOf(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

/**
 * Turn a nanosecond timestamp into whole milliseconds.
 *
 * The division happens in `bigint`, so nothing rounds before the value is small
 * enough for a double to hold exactly; parsing the string as a number first
 * would quantise the timestamp before it was ever truncated.
 */
function millisOf(value: unknown): number | undefined {
  const nanos = integerOf(value);
  if (nanos === undefined) return undefined;
  const millis = Number(nanos / 1_000_000n);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

function stringAttribute(attributes: OtlpAttribute[], key: string): string | undefined {
  for (const attribute of attributes) {
    if (attribute?.key !== key) continue;
    const value = attribute.value?.stringValue;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function hasAttribute(attributes: OtlpAttribute[] | undefined, key: string): boolean {
  return (attributes ?? []).some((attribute) => attribute?.key === key);
}

/** The window one metric's data points cover, as the earliest start and the latest end. */
interface Span {
  start: number;
  end: number;
}

function spanOf(point: OtlpDataPoint): Span | undefined {
  const start = millisOf(point.startTimeUnixNano);
  const end = millisOf(point.timeUnixNano);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function widen(current: Span | undefined, next: Span): Span {
  if (current === undefined) return next;
  return { start: Math.min(current.start, next.start), end: Math.max(current.end, next.end) };
}

function temporalityAccepted(temporality: unknown): boolean {
  return DELTA_TEMPORALITY.includes(temporality);
}

function unsupportedTemporality(metric: string, temporality: unknown): AdapterError {
  return new AdapterError(
    "otlp_unsupported_temporality",
    `${metric}: expected delta temporality, received ${echo(temporality)}; a cumulative series measures since process start, not since the window opened`,
  );
}

/** Every metric in the export, flattened: which scope emitted one says nothing about its meaning. */
function collectMetrics(resources: OtlpResourceMetrics[]): OtlpMetric[] {
  const metrics: OtlpMetric[] = [];
  for (const resource of resources) {
    for (const scope of resource?.scopeMetrics ?? []) {
      for (const metric of scope?.metrics ?? []) metrics.push(metric);
    }
  }
  return metrics;
}

interface Identity {
  service: string;
  env: PacketEnv;
}

/**
 * Who this export is about.
 *
 * One packet describes one service in one environment, so two resources that
 * disagree are refused instead of resolved: picking the first would file the
 * second service's traffic under the first service's name, where nobody would
 * ever look for it.
 */
function readIdentity(resources: OtlpResourceMetrics[]): Identity | AdapterError {
  const found = new Map<string, Identity>();

  for (const resource of resources) {
    const attributes = resource?.resource?.attributes ?? [];

    const service = stringAttribute(attributes, SERVICE_ATTRIBUTE);
    if (service === undefined) {
      return new AdapterError(
        "otlp_missing_service_name",
        `resource.attributes: expected a ${SERVICE_ATTRIBUTE} attribute naming the service this export describes`,
      );
    }

    const declared = stringAttribute(attributes, ENVIRONMENT_ATTRIBUTE);
    if (declared === undefined) {
      return new AdapterError(
        "otlp_missing_environment",
        `resource.attributes: expected a ${ENVIRONMENT_ATTRIBUTE} attribute; defaulting to prod would label a staging incident as a production one`,
      );
    }

    const env = ENVIRONMENTS[declared.toLowerCase()];
    if (env === undefined) {
      return new AdapterError(
        "otlp_unknown_environment",
        `${ENVIRONMENT_ATTRIBUTE}: expected one of ${Object.keys(ENVIRONMENTS).join(", ")}, received ${echo(declared)}`,
      );
    }

    found.set(`${env}:${service}`, { service, env });
  }

  const identities = [...found.values()];
  if (identities.length > 1) {
    return new AdapterError(
      "otlp_multiple_services",
      `resourceMetrics: expected one service and environment, received ${[...found.keys()].sort().join(", ")}`,
    );
  }

  const identity = identities[0];
  if (identity === undefined) {
    return new AdapterError("otlp_malformed_export", "resourceMetrics: expected at least one resource");
  }
  return identity;
}

/** The three numbers the export cannot carry, taken as the producer sent them. */
interface Baselines {
  error_rate: unknown;
  p95_latency_ms: unknown;
  slo_burn_rate: unknown;
}

/**
 * Read the sibling baselines block, refusing the export when it is absent.
 *
 * Only presence is checked here. A baseline that is present but is not a number
 * — or is not finite — is left to the packet validator below, so a bad baseline
 * is judged by exactly the rules that would have judged a hand-written packet.
 */
function readBaselines(value: unknown): Baselines | AdapterError {
  const baselines = asRecord(value);
  if (baselines === undefined) {
    return new AdapterError(
      "otlp_missing_baselines",
      "baselines: expected an object carrying error_rate and p95_latency_ms, because one OTLP export cannot say what normal looked like",
    );
  }

  for (const field of ["error_rate", "p95_latency_ms"] as const) {
    if (baselines[field] === undefined || baselines[field] === null) {
      return new AdapterError(
        "otlp_missing_baselines",
        `baselines.${field}: expected a number; every delta the judge reads is measured against it`,
      );
    }
  }

  return {
    error_rate: baselines.error_rate,
    p95_latency_ms: baselines.p95_latency_ms,
    // Absent means the producer publishes no error budget for this service, and
    // the contract has no way to say that other than no burn.
    slo_burn_rate: baselines.slo_burn_rate ?? 0,
  };
}

interface RequestCounts {
  total: number;
  errors: number;
  span: Span;
}

function pointValue(point: OtlpNumberDataPoint): number | undefined {
  const asInt = integerOf(point.asInt);
  if (asInt !== undefined) return Number(asInt);
  if (typeof point.asDouble === "number" && Number.isFinite(point.asDouble) && point.asDouble >= 0) {
    return point.asDouble;
  }
  return undefined;
}

/**
 * Total and failed request counts, from the counter split by `error.type`.
 *
 * Failure is read from the attribute's presence rather than from a status code,
 * because that is the one convention every OTLP instrumentation shares; a point
 * carrying it is failed traffic whatever the value says.
 */
function readRequestCounts(metrics: OtlpMetric[], name: string): RequestCounts | AdapterError {
  const series = metrics.filter((metric) => metric?.name === name && metric.sum !== undefined);
  if (series.length === 0) {
    return new AdapterError(
      "otlp_missing_metric",
      `${name}: expected a sum metric carrying the request count for this window`,
    );
  }

  let total = 0;
  let errors = 0;
  let span: Span | undefined;

  for (const metric of series) {
    const sum = metric.sum as OtlpSum;
    if (!temporalityAccepted(sum.aggregationTemporality)) {
      return unsupportedTemporality(name, sum.aggregationTemporality);
    }

    for (const point of sum.dataPoints ?? []) {
      const value = pointValue(point);
      if (value === undefined) {
        return new AdapterError(
          "otlp_malformed_data_point",
          `${name}: expected every data point to carry asInt or a finite asDouble`,
        );
      }
      const pointSpan = spanOf(point);
      if (pointSpan === undefined) {
        return new AdapterError(
          "otlp_missing_timestamps",
          `${name}: expected every data point to carry startTimeUnixNano and timeUnixNano`,
        );
      }

      total += value;
      if (hasAttribute(point.attributes, ERROR_ATTRIBUTE)) errors += value;
      span = widen(span, pointSpan);
    }
  }

  if (span === undefined || total <= 0) {
    return new AdapterError(
      "otlp_empty_counter",
      `${name}: expected at least one request in the window; an error rate over no traffic is a division by zero`,
    );
  }

  return { total, errors, span };
}

interface Latency {
  p95: number;
  span: Span;
}

function boundsMatch(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((bound, index) => bound === right[index]);
}

/**
 * The 95th percentile, read off the histogram's bucket boundaries.
 *
 * Buckets are what a histogram has, so the answer is the upper bound of the
 * bucket the 95th observation falls in and is therefore as coarse as the
 * producer's boundaries. Interpolating inside a bucket would invent a precision
 * the export does not contain. Traffic past the last boundary lands in the
 * unbounded overflow bucket, which has no upper bound to report, so the highest
 * declared boundary is returned and is a floor rather than an estimate.
 */
function readLatency(metrics: OtlpMetric[], name: string): Latency | AdapterError {
  const series = metrics.filter((metric) => metric?.name === name && metric.histogram !== undefined);
  if (series.length === 0) {
    return new AdapterError(
      "otlp_missing_metric",
      `${name}: expected a histogram metric carrying request durations for this window`,
    );
  }

  let bounds: number[] | undefined;
  let counts: number[] = [];
  let span: Span | undefined;
  let scale: number | undefined;

  for (const metric of series) {
    const histogram = metric.histogram as OtlpHistogram;
    if (!temporalityAccepted(histogram.aggregationTemporality)) {
      return unsupportedTemporality(name, histogram.aggregationTemporality);
    }

    const unit = DURATION_SCALE[(metric.unit ?? "").trim()];
    if (unit === undefined) {
      return new AdapterError(
        "otlp_unsupported_unit",
        `${name}: expected a unit of ${Object.keys(DURATION_SCALE).join(" or ")}, received ${echo(metric.unit)}; reading seconds as milliseconds would understate latency a thousandfold`,
      );
    }
    scale = unit;

    for (const point of histogram.dataPoints ?? []) {
      const declared = point.explicitBounds;
      const bucketCounts = point.bucketCounts;
      if (
        !Array.isArray(declared) ||
        !declared.every((bound) => typeof bound === "number" && Number.isFinite(bound)) ||
        !Array.isArray(bucketCounts) ||
        bucketCounts.length !== declared.length + 1
      ) {
        return new AdapterError(
          "otlp_malformed_histogram",
          `${name}: expected explicitBounds of finite numbers and one more bucketCount than bounds`,
        );
      }

      if (bounds === undefined) {
        bounds = declared;
        counts = new Array<number>(bucketCounts.length).fill(0);
      } else if (!boundsMatch(bounds, declared)) {
        return new AdapterError(
          "otlp_incompatible_histogram",
          `${name}: expected every data point to share one set of explicitBounds; summing buckets of different widths would move the percentile`,
        );
      }

      for (let index = 0; index < bucketCounts.length; index++) {
        const bucket = integerOf(bucketCounts[index]);
        if (bucket === undefined) {
          return new AdapterError(
            "otlp_malformed_histogram",
            `${name}: expected every bucketCount to be a non-negative integer`,
          );
        }
        counts[index] = (counts[index] ?? 0) + Number(bucket);
      }

      const pointSpan = spanOf(point);
      if (pointSpan === undefined) {
        return new AdapterError(
          "otlp_missing_timestamps",
          `${name}: expected every data point to carry startTimeUnixNano and timeUnixNano`,
        );
      }
      span = widen(span, pointSpan);
    }
  }

  const observations = counts.reduce((running, bucket) => running + bucket, 0);
  if (bounds === undefined || span === undefined || scale === undefined || observations === 0) {
    return new AdapterError(
      "otlp_empty_histogram",
      `${name}: expected at least one recorded duration; a histogram with no counts has no 95th percentile, and reporting zero would read as a healthy service`,
    );
  }

  const target = observations * PERCENTILE;
  let cumulative = 0;
  let index = 0;
  for (; index < counts.length; index++) {
    cumulative += counts[index] ?? 0;
    if (cumulative >= target) break;
  }

  const highest = bounds[bounds.length - 1] ?? 0;
  const upper = index < bounds.length ? (bounds[index] ?? highest) : highest;
  return { p95: upper * scale, span };
}

/**
 * The packet id a retry of this export lands on.
 *
 * Derived rather than random, so a collector that resends the same window
 * deduplicates through the packet-id path the Agent already has instead of
 * filing a second copy of one incident. The inputs and the truncation length
 * are frozen: they are how stored packets are addressed.
 */
async function derivePacketId(service: string, env: PacketEnv, window: PacketWindow): Promise<string> {
  const material = `${service}\n${env}\n${window.start}\n${window.end}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, PACKET_ID_LENGTH);
}

/**
 * Translate one OTLP/JSON metrics export into a normalized packet.
 *
 * The last step hands the assembled packet to `validatePacket`, the same
 * function the door runs over a producer-written packet. Translating into a
 * shape this repository would refuse from anyone else is a bug in the adapter,
 * and this is where it surfaces rather than three layers later inside an Agent.
 */
export async function otlpToPacket(
  input: unknown,
  options: OtlpAdapterOptions = {},
): Promise<Packet | AdapterError> {
  const body = asRecord(input);
  if (body === undefined) {
    return new AdapterError(
      "otlp_malformed_export",
      "export: expected an OTLP/JSON ExportMetricsServiceRequest object",
    );
  }

  const resources = body.resourceMetrics;
  if (!Array.isArray(resources) || resources.length === 0) {
    return new AdapterError(
      "otlp_malformed_export",
      "resourceMetrics: expected a non-empty array of resource metrics",
    );
  }

  const identity = readIdentity(resources as OtlpResourceMetrics[]);
  if (identity instanceof AdapterError) return identity;

  const baselines = readBaselines(body.baselines);
  if (baselines instanceof AdapterError) return baselines;

  const metrics = collectMetrics(resources as OtlpResourceMetrics[]);
  const counts = readRequestCounts(metrics, options.requestMetric ?? DEFAULT_REQUEST_METRIC);
  if (counts instanceof AdapterError) return counts;
  const latency = readLatency(metrics, options.durationMetric ?? DEFAULT_DURATION_METRIC);
  if (latency instanceof AdapterError) return latency;

  const span = widen(counts.span, latency.span);
  if (span.end <= span.start) {
    return new AdapterError(
      "otlp_invalid_window",
      `window: expected timeUnixNano after startTimeUnixNano, received a window of ${span.end - span.start}ms`,
    );
  }
  const window: PacketWindow = {
    start: new Date(span.start).toISOString(),
    end: new Date(span.end).toISOString(),
  };

  const seconds = (span.end - span.start) / 1000;
  const candidate = {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: await derivePacketId(identity.service, identity.env, window),
    service: identity.service,
    env: identity.env,
    window,
    signals: {
      error_rate: counts.errors / counts.total,
      error_rate_baseline: baselines.error_rate,
      p95_latency_ms: latency.p95,
      p95_latency_baseline_ms: baselines.p95_latency_ms,
      request_rate_rps: counts.total / seconds,
      slo_burn_rate: baselines.slo_burn_rate,
    },
    // A metrics export carries no spans, no exemplars and no alert routing, and
    // the MVP reads no other signal, so these are empty rather than fabricated.
    top_spans: [],
    exemplar_trace_ids: [],
    alert_labels: [],
  };

  const result = validatePacket(candidate);
  if (!result.ok) {
    return new AdapterError(
      "otlp_invalid_packet",
      `the translated packet is not a valid packet: ${result.errors.join("; ")}`,
    );
  }
  return result.packet;
}

/**
 * The verified OTLP route.
 *
 * Verification and the size cap are the normalized route's, unchanged: a
 * collector holding the firehose secret signs the bytes it sends and an
 * oversize export is dropped before any of the work above runs. What differs is
 * only what travels onward — the translated packet rather than the posted
 * bytes, because the Agent's contract is the packet and it stays that way.
 */
export async function handleOtlpIngest(request: Request, env: IngestEnv): Promise<Response> {
  const body = await readVerifiedBody(request, env);
  if (body instanceof Response) return body;

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return jsonError(
      "malformed_payload",
      "export: expected an OTLP/JSON object, received a body that is not valid JSON",
      400,
    );
  }

  const translated = await otlpToPacket(payload);
  if (translated instanceof AdapterError) return jsonError(translated.code, translated.message, 400);

  return forwardToAgent(env, agentNameForPacket(translated), JSON.stringify(translated));
}
