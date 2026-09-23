/**
 * Live board snapshot published to WebSocket clients (demo contract).
 *
 * Field names are camelCase on purpose: the demo's `adaptAgentState` rejects
 * anything without a `packets` array and expects this exact wire shape. Keep
 * this module free of React and of the older metrics-shaped JudgeState.
 */

import type { Packet as IntakePacket } from "../packet/types";
import type { JevResult } from "../jev/types";
import type { Verdict, VerdictSeverity } from "../llm/judge";
import type { Stage } from "./state";

/** Instance name the demo board connects to (`AGENT_INSTANCE` in otel-judge-demo). */
export const BOARD_INSTANCE_NAME = "board";

/**
 * Marks an internal POST as the board wipe rather than a packet to accept.
 *
 * The Agent's door is one method on one path, so a request says which of the
 * internal operations it is in a header. Spelled here beside the instance name
 * because the writer is the reset route and the reader is the Agent: two files,
 * and a literal in each is a rename waiting to go half-done.
 */
export const BOARD_RESET_HEADER = "x-otel-judge-board-reset";

/** Cap so a busy firehose cannot grow Agent state without bound. */
export const MAX_BOARD_PACKETS = 48;

export type PacketStage = "ingest" | "jev" | "llama" | "verdict";

export type JevDistribution = Record<string, number>;

export type LlamaVerdictLabel = "pass" | "flag" | "escalate";

/**
 * What System Two concluded, in the two lengths a board reads at.
 *
 * `rationale` is the one-sentence summary the chip itself carries; `critique` is
 * the longer reasoning behind the grade, which the demo opens in a sidebar
 * rather than crowding onto a chip. It is written as an empty string when the
 * judge produced none, never omitted, so a client reading it does not have to
 * tell a quiet verdict apart from an older wire shape.
 */
export interface LlamaVerdict {
  label: LlamaVerdictLabel;
  rationale: string;
  critique: string;
  actions: string[];
}

export interface PacketSummary {
  service: string;
  operation: string;
  durationMs: number;
  statusCode: number;
}

export interface BoardPacket {
  id: string;
  stage: PacketStage;
  receivedAt: string;
  summary: PacketSummary;
  jev?: JevDistribution;
  llama?: LlamaVerdict;
  /**
   * Present only on a run that ended with System One unavailable and System Two
   * therefore never asked. The demo keys its "Jev unavailable — Llama skipped"
   * chip off this field's presence, so it is written as a literal `true` or not
   * written at all; a `false` here would read as skipped on the board.
   */
  jevUnavailable?: true;
  /**
   * What each system cost, in whole milliseconds, when it was asked and answered.
   *
   * Absent rather than zero when that model did not run — an unreachable System
   * One times nothing, and a System Two that was never asked has no duration to
   * report — because the demo draws a dash for a missing field and would draw a
   * suspiciously fast model for a present zero.
   */
  jevLatencyMs?: number;
  llamaLatencyMs?: number;
}

export interface ProducerState {
  scenario: string;
  ratePerSec: number;
  paused: boolean;
}

export interface BoardState {
  packets: BoardPacket[];
  producer: ProducerState;
  updatedAt: string;
}

/**
 * Idle board every cold Agent publishes. An empty `packets` array adapts cleanly
 * in the demo (live badge, empty columns) — that is the DEGRADED → live fix.
 */
export const INITIAL_BOARD_STATE: BoardState = {
  packets: [],
  producer: { scenario: "", ratePerSec: 0, paused: false },
  updatedAt: "1970-01-01T00:00:00.000Z",
};

/**
 * Map internal evaluate stages onto the four demo columns.
 *
 * A column is where the packet is waiting or being worked, so `jev` is the chip
 * being asked of System One and `llama` is the chip in front of System Two —
 * both of them held there for the whole of that model's turn, retries included.
 */
export function packetStageFor(stage: Stage): PacketStage | null {
  switch (stage) {
    case "accepted":
    case "summarized":
      return "ingest";
    case "jev":
      return "jev";
    case "judging":
      return "llama";
    case "judged":
    case "complete":
    case "failed":
      return "verdict";
    case "idle":
      return null;
  }
}

/** Compact chip summary derived from the intake packet (no model involved). */
export function summaryFromIntake(packet: IntakePacket): PacketSummary {
  const top = packet.top_spans[0];
  return {
    service: packet.service,
    operation: top?.name ?? packet.service,
    durationMs: packet.signals.p95_latency_ms,
    // Packets do not carry an HTTP status; a non-zero error rate is the closest
    // stand-in so the chip still shows something other than a silent 0.
    statusCode: packet.signals.error_rate > 0 ? 500 : 200,
  };
}

export function boardPacketFromIntake(packet: IntakePacket, receivedAt: string): BoardPacket {
  return {
    id: packet.packet_id,
    stage: "ingest",
    receivedAt,
    summary: summaryFromIntake(packet),
  };
}

/**
 * Upsert by id, newest-last, then trim to the cap from the front so the live
 * board keeps the most recent chips.
 */
export function upsertBoardPacket(state: BoardState, packet: BoardPacket, now: Date = new Date()): BoardState {
  const without = state.packets.filter((entry) => entry.id !== packet.id);
  const packets = [...without, packet];
  const trimmed =
    packets.length > MAX_BOARD_PACKETS ? packets.slice(packets.length - MAX_BOARD_PACKETS) : packets;
  return {
    ...state,
    packets: trimmed,
    updatedAt: now.toISOString(),
  };
}

/** Severity question distribution when System One answered; otherwise absent. */
export function jevDistributionFromResult(jev: JevResult): JevDistribution | undefined {
  if (!jev.ok) return undefined;
  const severity = jev.answers.find((answer) => answer.key === "severity");
  if (!severity) return undefined;
  return { ...severity.distribution };
}

/**
 * A duration fit to publish, or nothing.
 *
 * Every latency reaching the wire passes through here, so a NaN from arithmetic
 * on a missing timestamp or a negative from a stepped clock is dropped at the
 * boundary instead of being rendered on a chip. Whole milliseconds, because the
 * board shows a number and a fraction of a millisecond is not news.
 */
export function publishableLatencyMs(latency: number | undefined): number | undefined {
  if (latency === undefined) return undefined;
  if (!Number.isFinite(latency) || latency < 0) return undefined;
  return Math.round(latency);
}

/** What System One cost when it answered; a failed call timed nothing worth showing. */
export function jevLatencyFromResult(jev: JevResult): number | undefined {
  return jev.ok ? publishableLatencyMs(jev.latency_ms) : undefined;
}

export function severityToLlamaLabel(severity: VerdictSeverity | string): LlamaVerdictLabel {
  switch (severity) {
    case "sev0":
      return "escalate";
    case "sev1":
    case "sev2":
      return "flag";
    case "noise":
      return "pass";
    default:
      return "flag";
  }
}

/**
 * The board's reading of a verdict.
 *
 * The critique is taken as it stands at this moment rather than from the
 * model's reply, which is what carries a deference note into the sidebar: the
 * note is appended to the critique before the verdict reaches here, so the
 * board says the grade was System One's on exactly the runs where it was.
 */
export function llamaFromVerdict(verdict: Verdict): LlamaVerdict {
  const actions = verdict.next_action.trim() === "" ? [] : [verdict.next_action];
  return {
    label: severityToLlamaLabel(verdict.severity),
    rationale: verdict.summary,
    critique: verdict.critique,
    actions,
  };
}

/**
 * Write or drop the skipped-judge marker, never writing `false`.
 *
 * Presence is the signal the demo reads, so a chip that is no longer skipped has
 * to shed the field rather than carry a falsy one — otherwise a packet that was
 * re-evaluated into a verdict would keep announcing a skip that did not happen.
 */
function withJevUnavailable(packet: BoardPacket, unavailable: boolean): BoardPacket {
  if (unavailable) return { ...packet, jevUnavailable: true };
  const { jevUnavailable, ...rest } = packet;
  return jevUnavailable === undefined ? packet : rest;
}

/**
 * Apply a milestone onto an existing board packet (creating a stub if accept
 * somehow missed it). Returns the new board state.
 */
export function applyMilestoneToBoard(
  state: BoardState,
  milestone: {
    packet_id: string;
    stage: Stage;
    jev_distribution?: JevDistribution;
    jev_latency_ms?: number;
    llama_latency_ms?: number;
  },
  now: Date = new Date(),
): BoardState {
  const nextStage = packetStageFor(milestone.stage);
  if (nextStage === null) return state;

  const existing = state.packets.find((entry) => entry.id === milestone.packet_id);
  const base: BoardPacket = existing ?? {
    id: milestone.packet_id,
    stage: nextStage,
    receivedAt: now.toISOString(),
    summary: { service: "", operation: "", durationMs: 0, statusCode: 0 },
  };

  const jevLatencyMs = publishableLatencyMs(milestone.jev_latency_ms);
  const llamaLatencyMs = publishableLatencyMs(milestone.llama_latency_ms);

  const updated = withJevUnavailable(
    {
      ...base,
      stage: nextStage,
      ...(milestone.jev_distribution ? { jev: milestone.jev_distribution } : {}),
      // Compared against undefined rather than tested for truth: a call that
      // came back in under half a millisecond rounds to a legitimate 0 and must
      // still reach the chip.
      ...(jevLatencyMs === undefined ? {} : { jevLatencyMs }),
      ...(llamaLatencyMs === undefined ? {} : { llamaLatencyMs }),
    },
    // A milestone is a claim about a run still moving. An unreachable System One
    // is not yet a skipped System Two at this point, and a re-evaluation that
    // gets this far is entitled to lose whatever the last run concluded.
    false,
  );

  return upsertBoardPacket(state, updated, now);
}

export function applyTerminalToBoard(
  state: BoardState,
  args: {
    packet_id: string;
    ok: boolean;
    jev?: JevResult;
    verdict?: Verdict;
    llama_latency_ms?: number;
  },
  now: Date = new Date(),
): BoardState {
  const existing = state.packets.find((entry) => entry.id === args.packet_id);
  const base: BoardPacket = existing ?? {
    id: args.packet_id,
    stage: "verdict",
    receivedAt: now.toISOString(),
    summary: { service: "", operation: "", durationMs: 0, statusCode: 0 },
  };

  const jev = args.jev ? jevDistributionFromResult(args.jev) : base.jev;
  const llama = args.ok && args.verdict ? llamaFromVerdict(args.verdict) : base.llama;

  // A run that ended without a timed answer leaves whatever the chip already
  // carried alone, exactly as the distribution and the verdict above do. What it
  // may never do is put a duration beside a model that was not asked.
  const jevLatencyMs = args.jev ? jevLatencyFromResult(args.jev) : undefined;
  const llamaLatencyMs =
    args.ok && args.verdict ? publishableLatencyMs(args.llama_latency_ms) : undefined;

  const updated = withJevUnavailable(
    {
      ...base,
      stage: "verdict",
      ...(jev ? { jev } : {}),
      ...(llama ? { llama } : {}),
      ...(jevLatencyMs === undefined ? {} : { jevLatencyMs }),
      ...(llamaLatencyMs === undefined ? {} : { llamaLatencyMs }),
    },
    // A verdict — this run's or one an earlier run already left on the chip —
    // settles the packet: something judged it, so nothing was skipped. What is
    // left is the run that finished with no priors and no opinion, which is the
    // one case a stage of `verdict` alone cannot tell apart from a judged packet.
    llama === undefined && args.ok && args.jev !== undefined && !args.jev.ok,
  );

  return upsertBoardPacket(state, updated, now);
}
