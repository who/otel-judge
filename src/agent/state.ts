/**
 * Agent live state is the demo BoardState wire contract.
 *
 * Older metrics-shaped snapshots (`agent_name`, `packets_seen`, …) are gone on
 * purpose: the demo's `adaptAgentState` returns null without a `packets` array,
 * which painted DEGRADED despite a healthy WebSocket. See `boardState.ts`.
 */

export type {
  BoardPacket,
  BoardState,
  JevDistribution,
  LlamaVerdict,
  LlamaVerdictLabel,
  PacketStage,
  PacketSummary,
  ProducerState,
} from "./boardState";

export {
  BOARD_INSTANCE_NAME,
  INITIAL_BOARD_STATE,
  MAX_BOARD_PACKETS,
  applyMilestoneToBoard,
  applyTerminalToBoard,
  boardPacketFromIntake,
  jevDistributionFromResult,
  jevLatencyFromResult,
  llamaFromVerdict,
  publishableLatencyMs,
  packetStageFor,
  severityToLlamaLabel,
  summaryFromIntake,
  upsertBoardPacket,
} from "./boardState";

/** @deprecated Alias kept so call sites can say INITIAL_STATE; same object. */
export { INITIAL_BOARD_STATE as INITIAL_STATE } from "./boardState";

/**
 * The seven stages a judged packet moves through internally.
 *
 * Mapped onto the four demo columns by `packetStageFor`. `failed` is terminal
 * like `complete`: a run that fails has still finished.
 */
export type Stage =
  | "idle"
  | "accepted"
  | "summarized"
  | "jev"
  | "judging"
  | "complete"
  | "failed";
