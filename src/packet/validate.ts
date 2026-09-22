import type { ValidationResult } from "./errors";
import {
  PACKET_SCHEMA_VERSION,
  type Packet,
  type PacketEnv,
  type PacketSaturation,
  type PacketSignals,
  type PacketWindow,
  type RecentDeploy,
  type TopSpan,
} from "./types";

const MAX_PACKET_ID_LENGTH = 128;
const MAX_SERVICE_LENGTH = 64;
const MAX_TOP_SPANS = 20;
const MAX_EXEMPLAR_TRACE_IDS = 10;
const MAX_ALERT_LABELS = 20;
const MAX_LOG_SNIPPETS = 10;
const MAX_LOG_SNIPPET_LENGTH = 500;

/** A packet id becomes a SQL key and a log token, so it stays to characters that need no quoting. */
const PACKET_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** UTC only: a window that carries an offset invites two producers to disagree about noon. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const ENVIRONMENTS: readonly PacketEnv[] = ["prod", "staging", "dev"];

const PACKET_KEYS: readonly string[] = [
  "schema_version",
  "packet_id",
  "service",
  "env",
  "window",
  "signals",
  "top_spans",
  "exemplar_trace_ids",
  "alert_labels",
  "recent_deploy",
  "log_snippets",
];

const SIGNAL_KEYS: readonly string[] = [
  "error_rate",
  "error_rate_baseline",
  "p95_latency_ms",
  "p95_latency_baseline_ms",
  "request_rate_rps",
  "slo_burn_rate",
  "saturation",
];

const SATURATION_KEYS: readonly string[] = ["cpu_pct", "mem_pct", "queue_depth"];

/** How much of an offending value an error string is allowed to quote back. */
const MAX_RECEIVED_LENGTH = 48;

/**
 * Render an offending value for an error message without trusting it.
 *
 * The input came off the wire, so it can be a bigint, a cycle, or a megabyte of
 * text. Rendering is therefore bounded and cannot throw: an error string that
 * blows up while describing an error is the worst possible failure here.
 */
function received(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);

  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length > MAX_RECEIVED_LENGTH
    ? `${rendered.slice(0, MAX_RECEIVED_LENGTH)}...`
    : rendered;
}

/** Record one field-level failure and hand back the absence the caller checks for. */
function fail(errors: string[], path: string, expected: string, value: unknown): undefined {
  errors.push(`${path}: expected ${expected}, received ${received(value)}`);
  return undefined;
}

function requireObject(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(errors, path, "a JSON object", value);
  }
  return value as Record<string, unknown>;
}

interface StringRule {
  /** Zero unless the contract names a minimum; only the packet id and service do. */
  min?: number;
  max?: number;
  pattern?: RegExp;
  expected: string;
}

function requireString(
  value: unknown,
  path: string,
  errors: string[],
  rule: StringRule,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < (rule.min ?? 0) ||
    (rule.max !== undefined && value.length > rule.max) ||
    (rule.pattern !== undefined && !rule.pattern.test(value))
  ) {
    return fail(errors, path, rule.expected, value);
  }
  return value;
}

/** `typeof` calls NaN and Infinity numbers; a ratio is neither, so finiteness is checked first. */
function requireNumberInRange(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return fail(errors, path, `number between ${min} and ${max}`, value);
  }
  return value;
}

function requireNumberAtLeast(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return fail(errors, path, `finite number of at least ${min}`, value);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, path: string, errors: string[]): string | undefined {
  if (
    typeof value !== "string" ||
    !ISO_UTC_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    return fail(errors, path, "an ISO 8601 UTC timestamp such as 2026-01-01T00:00:00Z", value);
  }
  return value;
}

/** The cap is what keeps the packet bounded; an over-long array is rejected whole, not trimmed. */
function requireArrayMax(
  value: unknown,
  path: string,
  errors: string[],
  max: number,
): unknown[] | undefined {
  if (!Array.isArray(value)) return fail(errors, path, "an array", value);
  if (value.length > max) {
    errors.push(`${path}: expected at most ${max} entries, received ${value.length}`);
    return undefined;
  }
  return value;
}

/**
 * Reject fields the contract does not define.
 *
 * Strictness here is a security property rather than tidiness: without it a
 * producer can hang a whole raw OTLP tree off an undeclared key and the judge
 * will faithfully store and summarize it.
 */
function rejectUnknownKeys(
  object: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      errors.push(
        `${prefix}${key}: unexpected field, packet schema version ${PACKET_SCHEMA_VERSION} does not define it`,
      );
    }
  }
}

function requireEnv(value: unknown, errors: string[]): PacketEnv | undefined {
  for (const candidate of ENVIRONMENTS) {
    if (value === candidate) return candidate;
  }
  return fail(errors, "env", `one of ${ENVIRONMENTS.join(", ")}`, value);
}

function validateWindow(value: unknown, errors: string[]): PacketWindow | undefined {
  const object = requireObject(value, "window", errors);
  if (object === undefined) return undefined;

  const start = requireIsoTimestamp(object.start, "window.start", errors);
  const end = requireIsoTimestamp(object.end, "window.end", errors);
  if (start === undefined || end === undefined) return undefined;

  // A zero-length window has no rate to speak of, so equal ends are as wrong as
  // reversed ones. A very long window is left alone: backfills are legitimate.
  if (Date.parse(end) <= Date.parse(start)) {
    errors.push(
      `window.end: expected a timestamp strictly after window.start (${start}), received ${end}`,
    );
    return undefined;
  }
  return { start, end };
}

function validateSaturation(value: unknown, errors: string[]): PacketSaturation | undefined {
  const object = requireObject(value, "signals.saturation", errors);
  if (object === undefined) return undefined;
  rejectUnknownKeys(object, SATURATION_KEYS, "signals.saturation.", errors);

  const saturation: PacketSaturation = {};
  let complete = true;

  if (object.cpu_pct !== undefined) {
    const cpu = requireNumberInRange(object.cpu_pct, "signals.saturation.cpu_pct", errors, 0, 100);
    if (cpu === undefined) complete = false;
    else saturation.cpu_pct = cpu;
  }
  if (object.mem_pct !== undefined) {
    const mem = requireNumberInRange(object.mem_pct, "signals.saturation.mem_pct", errors, 0, 100);
    if (mem === undefined) complete = false;
    else saturation.mem_pct = mem;
  }
  if (object.queue_depth !== undefined) {
    const depth = requireNumberAtLeast(object.queue_depth, "signals.saturation.queue_depth", errors, 0);
    if (depth === undefined) complete = false;
    else saturation.queue_depth = depth;
  }

  return complete ? saturation : undefined;
}

function validateSignals(value: unknown, errors: string[]): PacketSignals | undefined {
  const object = requireObject(value, "signals", errors);
  if (object === undefined) return undefined;
  rejectUnknownKeys(object, SIGNAL_KEYS, "signals.", errors);

  const errorRate = requireNumberInRange(object.error_rate, "signals.error_rate", errors, 0, 1);
  const errorRateBaseline = requireNumberInRange(
    object.error_rate_baseline,
    "signals.error_rate_baseline",
    errors,
    0,
    1,
  );
  const latency = requireNumberAtLeast(object.p95_latency_ms, "signals.p95_latency_ms", errors, 0);
  const latencyBaseline = requireNumberAtLeast(
    object.p95_latency_baseline_ms,
    "signals.p95_latency_baseline_ms",
    errors,
    0,
  );
  const requestRate = requireNumberAtLeast(object.request_rate_rps, "signals.request_rate_rps", errors, 0);
  const burnRate = requireNumberAtLeast(object.slo_burn_rate, "signals.slo_burn_rate", errors, 0);
  const saturation =
    object.saturation === undefined ? undefined : validateSaturation(object.saturation, errors);

  if (
    errorRate === undefined ||
    errorRateBaseline === undefined ||
    latency === undefined ||
    latencyBaseline === undefined ||
    requestRate === undefined ||
    burnRate === undefined ||
    (object.saturation !== undefined && saturation === undefined)
  ) {
    return undefined;
  }

  const signals: PacketSignals = {
    error_rate: errorRate,
    error_rate_baseline: errorRateBaseline,
    p95_latency_ms: latency,
    p95_latency_baseline_ms: latencyBaseline,
    request_rate_rps: requestRate,
    slo_burn_rate: burnRate,
  };
  if (saturation !== undefined) signals.saturation = saturation;
  return signals;
}

function validateTopSpans(value: unknown, errors: string[]): TopSpan[] | undefined {
  const entries = requireArrayMax(value, "top_spans", errors, MAX_TOP_SPANS);
  if (entries === undefined) return undefined;

  const spans: TopSpan[] = [];
  let complete = true;

  entries.forEach((entry, index) => {
    const path = `top_spans[${index}]`;
    const object = requireObject(entry, path, errors);
    if (object === undefined) {
      complete = false;
      return;
    }

    const name = requireString(object.name, `${path}.name`, errors, { expected: "a string" });
    const count = requireNumberAtLeast(object.count, `${path}.count`, errors, 0);
    const errorCount = requireNumberAtLeast(object.error_count, `${path}.error_count`, errors, 0);
    const p95 = requireNumberAtLeast(object.p95_ms, `${path}.p95_ms`, errors, 0);
    if (name === undefined || count === undefined || errorCount === undefined || p95 === undefined) {
      complete = false;
      return;
    }

    // Unlike the top level, extra keys here are dropped rather than rejected:
    // span exporters legitimately decorate spans with their own attributes, and
    // copying only the four declared fields keeps them out of the judge anyway.
    spans.push({ name, count, error_count: errorCount, p95_ms: p95 });
  });

  return complete ? spans : undefined;
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: string[],
  max: number,
  rule: StringRule,
): string[] | undefined {
  const entries = requireArrayMax(value, path, errors, max);
  if (entries === undefined) return undefined;

  const values: string[] = [];
  let complete = true;
  entries.forEach((entry, index) => {
    const text = requireString(entry, `${path}[${index}]`, errors, rule);
    if (text === undefined) complete = false;
    else values.push(text);
  });
  return complete ? values : undefined;
}

function validateRecentDeploy(value: unknown, errors: string[]): RecentDeploy | undefined {
  const object = requireObject(value, "recent_deploy", errors);
  if (object === undefined) return undefined;

  const version = requireString(object.version, "recent_deploy.version", errors, {
    expected: "a string",
  });
  const deployedAt = requireIsoTimestamp(object.deployed_at, "recent_deploy.deployed_at", errors);
  const minutesAgo = requireNumberAtLeast(object.minutes_ago, "recent_deploy.minutes_ago", errors, 0);
  if (version === undefined || deployedAt === undefined || minutesAgo === undefined) return undefined;

  return { version, deployed_at: deployedAt, minutes_ago: minutesAgo };
}

/**
 * Turn an unknown payload into a packet, or into the list of reasons it is not one.
 *
 * This never throws, and it never coerces: a string where a number belongs is an
 * error, not a conversion, because a producer that is quietly corrected keeps
 * sending the wrong thing. Every field is checked even after one has failed, so
 * a producer fixing its integration sees the whole list in a single round trip
 * instead of discovering one problem per deploy.
 *
 * The returned packet is assembled field by field from values already checked,
 * so it shares no structure with the input: nothing a caller does to the payload
 * afterwards can reach into what was stored.
 */
export function validatePacket(input: unknown): ValidationResult {
  const errors: string[] = [];

  const object = requireObject(input, "packet", errors);
  if (object === undefined) return { ok: false, code: "malformed_payload", errors };

  // Checked before anything else and returned alone: field rules belong to a
  // version, so reporting them against a version we do not implement would be
  // telling the producer about a contract it is not using.
  if (object.schema_version !== PACKET_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "unsupported_schema_version",
      errors: [
        `schema_version: expected ${PACKET_SCHEMA_VERSION}, received ${received(object.schema_version)}`,
      ],
    };
  }

  rejectUnknownKeys(object, PACKET_KEYS, "", errors);

  const packetId = requireString(object.packet_id, "packet_id", errors, {
    min: 1,
    max: MAX_PACKET_ID_LENGTH,
    pattern: PACKET_ID_PATTERN,
    expected: `a string of 1 to ${MAX_PACKET_ID_LENGTH} characters matching [A-Za-z0-9._:-]`,
  });
  const service = requireString(
    typeof object.service === "string" ? object.service.trim() : object.service,
    "service",
    errors,
    { min: 1, max: MAX_SERVICE_LENGTH, expected: `a string of 1 to ${MAX_SERVICE_LENGTH} characters` },
  );
  const env = requireEnv(object.env, errors);
  const window = validateWindow(object.window, errors);
  const signals = validateSignals(object.signals, errors);
  const topSpans = validateTopSpans(object.top_spans, errors);
  const exemplarTraceIds = validateStringArray(
    object.exemplar_trace_ids,
    "exemplar_trace_ids",
    errors,
    MAX_EXEMPLAR_TRACE_IDS,
    { expected: "a string" },
  );
  const alertLabels = validateStringArray(object.alert_labels, "alert_labels", errors, MAX_ALERT_LABELS, {
    expected: "a string",
  });
  const recentDeploy =
    object.recent_deploy === undefined ? undefined : validateRecentDeploy(object.recent_deploy, errors);
  const logSnippets =
    object.log_snippets === undefined
      ? undefined
      : validateStringArray(object.log_snippets, "log_snippets", errors, MAX_LOG_SNIPPETS, {
          max: MAX_LOG_SNIPPET_LENGTH,
          expected: `a string of at most ${MAX_LOG_SNIPPET_LENGTH} characters`,
        });

  // Each absence above recorded at least one error, so this list is never empty
  // when the branch is taken; the checks are repeated only to narrow the types.
  if (
    errors.length > 0 ||
    packetId === undefined ||
    service === undefined ||
    env === undefined ||
    window === undefined ||
    signals === undefined ||
    topSpans === undefined ||
    exemplarTraceIds === undefined ||
    alertLabels === undefined
  ) {
    return { ok: false, code: "invalid_packet", errors };
  }

  const packet: Packet = {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: packetId,
    service,
    env,
    window,
    signals,
    top_spans: topSpans,
    // Trace ids are compared and rendered, never parsed, so one casing spares
    // every later consumer from deciding which spelling is canonical.
    exemplar_trace_ids: exemplarTraceIds.map((id) => id.toLowerCase()),
    // Labels arrive in whatever order an alerting rule happened to emit them;
    // deduplicating and sorting makes two identical alerts compare equal.
    alert_labels: [...new Set(alertLabels)].sort(),
  };
  if (recentDeploy !== undefined) packet.recent_deploy = recentDeploy;
  if (logSnippets !== undefined) packet.log_snippets = logSnippets;

  return { ok: true, packet };
}
