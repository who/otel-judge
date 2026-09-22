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

/** Cap so a busy firehose cannot grow Agent state without bound. */
export const MAX_BOARD_PACKETS = 48;

export type PacketStage = "ingest" | "jev" | "llama" | "verdict";

export type JevDistribution = Record<string, number>;

export type LlamaVerdictLabel = "pass" | "flag" | "escalate";

export interface LlamaVerdict {
  label: LlamaVerdictLabel;
  rationale: string;
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

/** Map internal evaluate stages onto the four demo columns. */
export function packetStageFor(stage: Stage): PacketStage | null {
  switch (stage) {
    case "accepted":
    case "summarized":
      return "ingest";
    case "jev":
      return "jev";
    case "judging":
      return "llama";
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

export function llamaFromVerdict(verdict: Verdict): LlamaVerdict {
  const actions = verdict.next_action.trim() === "" ? [] : [verdict.next_action];
  return {
    label: severityToLlamaLabel(verdict.severity),
    rationale: verdict.summary,
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

  const updated = withJevUnavailable(
    {
      ...base,
      stage: nextStage,
      ...(milestone.jev_distribution ? { jev: milestone.jev_distribution } : {}),
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

  const updated = withJevUnavailable(
    {
      ...base,
      stage: "verdict",
      ...(jev ? { jev } : {}),
      ...(llama ? { llama } : {}),
    },
    // A verdict — this run's or one an earlier run already left on the chip —
    // settles the packet: something judged it, so nothing was skipped. What is
    // left is the run that finished with no priors and no opinion, which is the
    // one case a stage of `verdict` alone cannot tell apart from a judged packet.
    llama === undefined && args.ok && args.jev !== undefined && !args.jev.ok,
  );

  return upsertBoardPacket(state, updated, now);
}
