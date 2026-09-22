import type { Packet } from "../packet/types";

/** Everything SQLite will accept as a bound value, and everything it hands back. */
export type SqlValue = string | number | boolean | null;

/**
 * The Agents SDK tagged template, named so it can be passed instead of reached for.
 *
 * Every helper below takes this callable as its first argument rather than
 * closing over an Agent. That is what lets the whole store be exercised against
 * a real Durable Object without standing up a request, and it keeps the SQL in
 * one file instead of spreading inline queries across the handlers.
 */
export type SqlTag = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
) => T[];

/** The shape an Agent already has; declared so the seam is explicit rather than implied. */
export interface SqlHost {
  sql<T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]): T[];
}

/**
 * Bind an Agent's `sql` method to the callable the helpers take.
 *
 * `Function.prototype.bind` would drop the row type parameter, so the wrapper
 * forwards it explicitly and callers keep their typed reads.
 */
export function sqlTag(host: SqlHost): SqlTag {
  return <T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] =>
    host.sql<T>(strings, ...values);
}

/** Where a packet is in its life, from accepted to one of the two terminal states. */
export type PacketStatus = "accepted" | "evaluating" | "complete" | "failed";

/**
 * How a System One call ended.
 *
 * `unavailable` and `error` are different facts a human wants told apart: the
 * first says nobody answered, the second says the answer could not be used.
 */
export type JevRunStatus = "ok" | "unavailable" | "error";

/** The status a freshly stored packet carries; the workflow moves it on from here. */
const INITIAL_PACKET_STATUS: PacketStatus = "accepted";

/** A read of the whole table is never worth it, so a caller cannot ask for one. */
export const MAX_RECENT_PACKETS = 100;

/** How many `cause` hops a thrown SQL error is followed for before giving up. */
const MAX_CAUSE_DEPTH = 8;

/** What a listing shows: enough to choose a packet, never the payload itself. */
export interface PacketSummary {
  packet_id: string;
  schema_version: number;
  service: string;
  env: string;
  window_start: string;
  window_end: string;
  received_at: string;
  status: PacketStatus;
}

/** One stored packet, with the payload exactly as it was validated. */
export interface StoredPacket extends PacketSummary {
  payload: Packet;
}

/**
 * One System One call, recorded whether or not it produced answers.
 *
 * This row exists separately from the answers so a failed or unreachable model
 * is a first-class fact rather than a fabricated distribution.
 */
export interface JevRun {
  packet_id: string;
  model: string | null;
  status: JevRunStatus;
  reason: string | null;
  latency_ms: number | null;
  created_at: string;
}

/**
 * One question's answer, stored whole.
 *
 * `answer` is the complete probability vector plus the noul mass exactly as
 * System One returned it. An argmax may ride along inside the same object, but
 * it never replaces the vector: the distribution is what System Two reasons
 * over and what history has to be able to show later.
 */
export interface JevAnswer {
  question_key: string;
  answer: unknown;
  created_at: string;
}

/**
 * An answer read back, or the fact that one row could not be parsed.
 *
 * Corruption in a single answer must not cost a caller the rest of the record,
 * so the failure is a value in the list rather than a thrown error.
 */
export type StoredAnswer =
  | { ok: true; question_key: string; created_at: string; answer: unknown }
  | { ok: false; question_key: string; created_at: string; error: string };

/** What System Two concluded, with the prose columns kept out of the raw blob. */
export interface Verdict {
  severity: string;
  summary: string | null;
  critique: string | null;
  next_action: string | null;
  disagrees_with_prior: boolean | null;
  model: string | null;
  raw: unknown;
  created_at: string;
}

/** A verdict read back; `raw` is null when the stored blob no longer parses. */
export interface StoredVerdict extends Omit<Verdict, "raw"> {
  raw: unknown;
}

/** A human's correction, which is the only judgement in here nobody may overwrite. */
export interface HumanLabel {
  label: string;
  note: string | null;
  created_at: string;
}

/** Everything known about one packet, assembled from all five tables. */
export interface PacketRecord {
  packet: StoredPacket;
  jev_run: JevRun | null;
  answers: StoredAnswer[];
  verdict: StoredVerdict | null;
  labels: HumanLabel[];
}

/**
 * Raised when a packet id is already stored.
 *
 * Callers are expected to ask `hasPacket` first; the primary key is the
 * backstop for the race they cannot see. It is a named error so the accept path
 * can answer a duplicate deliberately instead of turning a constraint message
 * into a 500.
 */
export class DuplicatePacketError extends Error {
  readonly packetId: string;

  constructor(packetId: string) {
    super(`packet ${packetId} is already stored`);
    this.name = "DuplicatePacketError";
    this.packetId = packetId;
  }
}

/**
 * Create every table and index this Agent needs, if they are not already there.
 *
 * Idempotent by construction rather than by bookkeeping: there is no version
 * row to consult and nothing to get out of step, so two cold starts racing each
 * other both succeed. Statements are issued one at a time because the tagged
 * template is a single-statement interface.
 */
export function ensureSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS packets (
    packet_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    service TEXT NOT NULL,
    env TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS jev_runs (
    packet_id TEXT PRIMARY KEY,
    model TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    latency_ms INTEGER,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS jev_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id TEXT NOT NULL,
    question_key TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS verdicts (
    packet_id TEXT PRIMARY KEY,
    severity TEXT NOT NULL,
    summary TEXT,
    critique TEXT,
    next_action TEXT,
    disagrees_with_prior INTEGER,
    model TEXT,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS human_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id TEXT NOT NULL,
    label TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE INDEX IF NOT EXISTS idx_packets_received_at ON packets (received_at DESC)`;
  sql`CREATE INDEX IF NOT EXISTS idx_jev_answers_packet ON jev_answers (packet_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_labels_packet ON human_labels (packet_id)`;
}

/**
 * Serialize a value for a JSON column without ever producing a non-string.
 *
 * `JSON.stringify` answers `undefined` for `undefined` and for a function, and
 * a column declared NOT NULL would then be handed something SQLite cannot bind.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * Decide whether a thrown error is SQLite refusing a constraint.
 *
 * The SDK wraps the platform error, so the chain is walked rather than the top
 * message read, and the walk is bounded because a `cause` cycle is possible.
 */
function isConstraintViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (/constraint failed/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Store a validated packet exactly as it arrived.
 *
 * `payload_json` keeps the packet whole, including the `schema_version` it came
 * with, so a packet stored under an older contract stays readable after the
 * contract moves. The indexed columns are copies, not the source of truth.
 */
export function insertPacket(sql: SqlTag, packet: Packet, receivedAt: string): void {
  try {
    sql`INSERT INTO packets (
      packet_id, schema_version, service, env,
      window_start, window_end, payload_json, received_at, status
    ) VALUES (
      ${packet.packet_id}, ${packet.schema_version}, ${packet.service}, ${packet.env},
      ${packet.window.start}, ${packet.window.end}, ${toJson(packet)},
      ${receivedAt}, ${INITIAL_PACKET_STATUS}
    )`;
  } catch (error) {
    if (isConstraintViolation(error)) throw new DuplicatePacketError(packet.packet_id);
    throw error;
  }
}

/** Whether this packet has been seen before, which is the whole of the dedupe read. */
export function hasPacket(sql: SqlTag, packetId: string): boolean {
  const rows = sql<{ found: number }>`
    SELECT COUNT(*) AS found FROM packets WHERE packet_id = ${packetId}`;
  return (rows[0]?.found ?? 0) > 0;
}

/**
 * How far the stored copy of this packet has got, or null when there is none.
 *
 * A producer that resends an id is told what the first copy is doing rather
 * than only that the id was taken, which is the difference between "your retry
 * was unnecessary" and "your packet is still being judged". This is one primary
 * key read rather than the whole record: the duplicate branch is on the accept
 * path and has no business assembling verdicts and labels to answer with a word.
 */
export function getPacketStatus(sql: SqlTag, packetId: string): PacketStatus | null {
  const rows = sql<{ status: string }>`
    SELECT status FROM packets WHERE packet_id = ${packetId}`;
  const row = rows[0];
  return row === undefined ? null : (row.status as PacketStatus);
}

/**
 * Record how a System One call went, replacing any earlier attempt.
 *
 * A workflow that retries after a partial failure records the run again, and an
 * upsert makes that replay ordinary rather than an error the retry has to catch.
 */
export function recordJevRun(sql: SqlTag, run: JevRun): void {
  sql`INSERT INTO jev_runs (packet_id, model, status, reason, latency_ms, created_at)
    VALUES (${run.packet_id}, ${run.model}, ${run.status}, ${run.reason}, ${run.latency_ms},
            ${run.created_at})
    ON CONFLICT (packet_id) DO UPDATE SET
      model = excluded.model,
      status = excluded.status,
      reason = excluded.reason,
      latency_ms = excluded.latency_ms,
      created_at = excluded.created_at`;
}

/**
 * Replace this packet's answers with the ones given.
 *
 * Replacing rather than appending is what makes a retry safe: the answers
 * belong to the run, so a second run's answers must not sit alongside the
 * first's and leave a reader to guess which distribution was current. An empty
 * list is therefore the correct way to record a run that produced nothing.
 */
export function recordJevAnswers(sql: SqlTag, packetId: string, answers: JevAnswer[]): void {
  sql`DELETE FROM jev_answers WHERE packet_id = ${packetId}`;
  for (const answer of answers) {
    sql`INSERT INTO jev_answers (packet_id, question_key, answer_json, created_at)
      VALUES (${packetId}, ${answer.question_key}, ${toJson(answer.answer)}, ${answer.created_at})`;
  }
}

/** Store the verdict, overwriting an earlier one so a replayed workflow succeeds. */
export function recordVerdict(sql: SqlTag, packetId: string, verdict: Verdict): void {
  // SQLite has no boolean, and a tri-state column needs null kept apart from 0.
  const disagrees =
    verdict.disagrees_with_prior === null ? null : verdict.disagrees_with_prior ? 1 : 0;

  sql`INSERT INTO verdicts (
      packet_id, severity, summary, critique, next_action,
      disagrees_with_prior, model, raw_json, created_at
    ) VALUES (
      ${packetId}, ${verdict.severity}, ${verdict.summary}, ${verdict.critique},
      ${verdict.next_action}, ${disagrees}, ${verdict.model}, ${toJson(verdict.raw)},
      ${verdict.created_at}
    )
    ON CONFLICT (packet_id) DO UPDATE SET
      severity = excluded.severity,
      summary = excluded.summary,
      critique = excluded.critique,
      next_action = excluded.next_action,
      disagrees_with_prior = excluded.disagrees_with_prior,
      model = excluded.model,
      raw_json = excluded.raw_json,
      created_at = excluded.created_at`;
}

/**
 * Move a stored packet to the status it has reached.
 *
 * An id with no row updates nothing and says nothing about it, because the only
 * caller that can reach here with an unknown id is one holding the outcome of a
 * workflow for a packet that was never stored, and inventing a row to carry a
 * status would be worse than the gap it papers over. Callers that need to tell
 * the two apart ask `hasPacket` first.
 */
export function setPacketStatus(sql: SqlTag, packetId: string, status: PacketStatus): void {
  sql`UPDATE packets SET status = ${status} WHERE packet_id = ${packetId}`;
}

/**
 * Attach a human's label to a packet.
 *
 * Labels accumulate instead of replacing one another: two people disagreeing
 * about the same incident is information, and the timestamp is taken here
 * because a label happens when the button is pressed and carries no earlier
 * moment of its own.
 *
 * The written row is handed back rather than discarded, because the timestamp
 * is invented in here and a caller that has to answer "what was stored" would
 * otherwise have to read the whole record back to learn a value this function
 * already had.
 */
export function recordHumanLabel(
  sql: SqlTag,
  packetId: string,
  label: string,
  note: string | null = null,
): HumanLabel {
  const createdAt = new Date().toISOString();
  sql`INSERT INTO human_labels (packet_id, label, note, created_at)
    VALUES (${packetId}, ${label}, ${note}, ${createdAt})`;
  return { label, note, created_at: createdAt };
}

/** The columns a summary is built from, before the status string is narrowed. */
interface PacketSummaryRow {
  packet_id: string;
  schema_version: number;
  service: string;
  env: string;
  window_start: string;
  window_end: string;
  received_at: string;
  status: string;
}

function toSummary(row: PacketSummaryRow): PacketSummary {
  return {
    packet_id: row.packet_id,
    schema_version: row.schema_version,
    service: row.service,
    env: row.env,
    window_start: row.window_start,
    window_end: row.window_end,
    received_at: row.received_at,
    status: row.status as PacketStatus,
  };
}

/**
 * The most recent packets, newest first.
 *
 * The limit is clamped rather than trusted, and a limit of zero or less is an
 * empty answer rather than an unbounded one: a caller asking for nothing must
 * never be the caller that reads the whole table.
 */
export function listRecentPackets(sql: SqlTag, limit: number): PacketSummary[] {
  const bounded = Math.min(Math.floor(limit), MAX_RECENT_PACKETS);
  if (!Number.isFinite(bounded) || bounded <= 0) return [];

  // Two packets can share a received_at, so the id breaks the tie and makes the
  // order total; without it paging would repeat or skip rows.
  return sql<PacketSummaryRow>`
    SELECT packet_id, schema_version, service, env, window_start, window_end, received_at, status
    FROM packets
    ORDER BY received_at DESC, packet_id DESC
    LIMIT ${bounded}`.map(toSummary);
}

/**
 * The severity each of these packets was judged at, for the ones that have one.
 *
 * A listing has to show a conclusion beside each row, and reading whole records
 * to recover one column apiece would pull five tables and every stored payload
 * through memory to render a list. Absent ids are simply missing from the map:
 * a packet still being evaluated, or one whose run failed, has no severity, and
 * a map with no entry says that without inventing a placeholder for it.
 *
 * The caller's list is already bounded by `listRecentPackets`, so this is at
 * most `MAX_RECENT_PACKETS` primary-key lookups against local storage. They are
 * issued one at a time because the tagged template binds a fixed number of
 * values and cannot be handed a variable-length `IN` list.
 */
export function verdictSeverities(
  sql: SqlTag,
  packetIds: readonly string[],
): Map<string, string> {
  const severities = new Map<string, string>();
  for (const packetId of packetIds) {
    const row = sql<{ severity: string }>`
      SELECT severity FROM verdicts WHERE packet_id = ${packetId}`[0];
    if (row !== undefined) severities.set(packetId, row.severity);
  }
  return severities;
}

/** Parse a stored blob, answering null when it is no longer JSON. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readAnswers(sql: SqlTag, packetId: string): StoredAnswer[] {
  const rows = sql<{ question_key: string; answer_json: string; created_at: string }>`
    SELECT question_key, answer_json, created_at
    FROM jev_answers
    WHERE packet_id = ${packetId}
    ORDER BY id`;

  return rows.map((row) => {
    try {
      return {
        ok: true,
        question_key: row.question_key,
        created_at: row.created_at,
        answer: JSON.parse(row.answer_json) as unknown,
      };
    } catch {
      // The parser's own message can quote the corrupt text back, so the
      // diagnostic is fixed and the unreadable value stays where it is.
      return {
        ok: false,
        question_key: row.question_key,
        created_at: row.created_at,
        error: "answer_json is not valid JSON",
      };
    }
  });
}

function readVerdict(sql: SqlTag, packetId: string): StoredVerdict | null {
  const rows = sql<{
    severity: string;
    summary: string | null;
    critique: string | null;
    next_action: string | null;
    disagrees_with_prior: number | null;
    model: string | null;
    raw_json: string;
    created_at: string;
  }>`
    SELECT severity, summary, critique, next_action, disagrees_with_prior, model, raw_json, created_at
    FROM verdicts
    WHERE packet_id = ${packetId}`;

  const row = rows[0];
  if (row === undefined) return null;

  return {
    severity: row.severity,
    summary: row.summary,
    critique: row.critique,
    next_action: row.next_action,
    disagrees_with_prior: row.disagrees_with_prior === null ? null : row.disagrees_with_prior !== 0,
    model: row.model,
    // The prose a human reads lives in its own columns, so an unreadable blob
    // costs the model's original response and nothing else.
    raw: tryParse(row.raw_json),
    created_at: row.created_at,
  };
}

/**
 * Everything stored about one packet, or null when there is no such packet.
 *
 * An unknown id is an ordinary question with an ordinary answer, not an
 * exception: history pages ask about ids that have aged out or never existed.
 */
export function getPacketRecord(sql: SqlTag, packetId: string): PacketRecord | null {
  const rows = sql<PacketSummaryRow & { payload_json: string }>`
    SELECT packet_id, schema_version, service, env, window_start, window_end,
           payload_json, received_at, status
    FROM packets
    WHERE packet_id = ${packetId}`;

  const row = rows[0];
  if (row === undefined) return null;

  const runs = sql<{
    packet_id: string;
    model: string | null;
    status: string;
    reason: string | null;
    latency_ms: number | null;
    created_at: string;
  }>`
    SELECT packet_id, model, status, reason, latency_ms, created_at
    FROM jev_runs
    WHERE packet_id = ${packetId}`;
  const run = runs[0];

  const labels = sql<{ label: string; note: string | null; created_at: string }>`
    SELECT label, note, created_at
    FROM human_labels
    WHERE packet_id = ${packetId}
    ORDER BY id`;

  return {
    // Written from a packet the validator already accepted, so this parse is a
    // deserialization rather than a trust boundary.
    packet: { ...toSummary(row), payload: JSON.parse(row.payload_json) as Packet },
    jev_run:
      run === undefined
        ? null
        : {
            packet_id: run.packet_id,
            model: run.model,
            status: run.status as JevRunStatus,
            reason: run.reason,
            latency_ms: run.latency_ms,
            created_at: run.created_at,
          },
    answers: readAnswers(sql, packetId),
    verdict: readVerdict(sql, packetId),
    labels: labels.map((label) => ({
      label: label.label,
      note: label.note,
      created_at: label.created_at,
    })),
  };
}

/**
 * How many packets this Agent has stored.
 *
 * The live snapshot's counter is published to clients but not durable, so it is
 * read back from the table on every wake rather than restarting at zero and
 * telling a watching browser the incident history was lost.
 */
export function countPackets(sql: SqlTag): number {
  const rows = sql<{ total: number }>`SELECT COUNT(*) AS total FROM packets`;
  return rows[0]?.total ?? 0;
}
