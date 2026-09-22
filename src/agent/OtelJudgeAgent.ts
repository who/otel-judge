import { Agent, callable, getAgentByName } from "agents";
import type { Packet } from "../packet/types";
import type { EvaluateMilestone } from "../workflow/evaluate";
import { acceptPacket, type AcceptOutcome } from "./accept";
import {
  clampHistoryLimit,
  DEFAULT_HISTORY_LIMIT,
  isHumanLabelName,
  LabelRejectedError,
  MAX_LABEL_NOTE_LENGTH,
  type HistoryRow,
  type PacketDetail,
} from "./api-types";
import {
  applyMilestoneToBoard,
  applyTerminalToBoard,
  BOARD_INSTANCE_NAME,
  boardPacketFromIntake,
  INITIAL_BOARD_STATE,
  upsertBoardPacket,
  type BoardPacket,
  type BoardState,
} from "./boardState";
import { agentNameForPacket } from "./identity";
import {
  persistEvaluation,
  readEvaluateResult,
  type EvaluationOutcome,
} from "./persist";
import {
  ensureSchema,
  getPacketRecord,
  hasPacket,
  listRecentPackets,
  recordHumanLabel,
  sqlTag,
  verdictSeverities,
  type HumanLabel,
} from "./store";

/** The workflow binding evaluation runs on, named once so the two uses cannot drift. */
const EVALUATE_WORKFLOW = "EVALUATE_WORKFLOW";

/**
 * Errors are JSON with a stable machine-readable code, never HTML: every caller
 * that reaches an Agent is a program. The shape matches the door's error body so
 * a client parses one thing regardless of which layer answered.
 */
function jsonError(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: code, message }, { status, headers });
}

/**
 * The judge itself: one durable instance per service and environment, plus the
 * shared `board` instance the demo watches.
 *
 * Live state is BoardState (demo wire contract). Per-service instances still
 * accept and evaluate; each board-visible change is mirrored onto `board`.
 */
export class OtelJudgeAgent extends Agent<Env, BoardState> {
  /** Copied per instance so two Agents can never share one snapshot object. */
  override initialState: BoardState = {
    ...INITIAL_BOARD_STATE,
    packets: [],
    producer: { ...INITIAL_BOARD_STATE.producer },
  };

  /**
   * Tables first. Board chips are not rebuilt from SQL on wake: history remains
   * available via getHistory/getPacket, and a cold `board` publishing an empty
   * packets array is exactly what the demo needs for a live idle badge.
   */
  override onStart(): void {
    ensureSchema(sqlTag(this));
    // Wrangler keeps DO SQLite across restarts. A metrics-shaped snapshot
    // (no packets[]) must be coerced or the demo stays DEGRADED forever.
    const raw = this.state as unknown as Record<string, unknown>;
    if (!Array.isArray(raw.packets)) {
      this.setState({
        ...INITIAL_BOARD_STATE,
        packets: [],
        producer: { ...INITIAL_BOARD_STATE.producer },
      });
    }
  }

  /**
   * Take a packet, or say precisely why this one was not taken.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonError(
        "method_not_allowed",
        `${request.method} is not supported; POST a packet instead`,
        405,
        { allow: "POST" },
      );
    }

    let body: string;
    try {
      body = await request.text();
    } catch {
      return jsonError("malformed_payload", "The request body could not be read", 400);
    }

    // Internal mirror from a per-service Agent onto the shared board instance.
    if (request.headers.get("x-otel-judge-board-upsert") === "1") {
      return this.handleBoardUpsert(body);
    }

    let outcome: AcceptOutcome;
    try {
      outcome = acceptPacket({ sql: sqlTag(this) }, body);
    } catch {
      return jsonError("storage_failure", "The packet could not be stored; retry it", 500);
    }

    switch (outcome.kind) {
      case "too_large":
        return jsonError("packet_too_large", `Request body exceeds ${outcome.limit} bytes`, 413);
      case "invalid":
        return Response.json({ error: outcome.code, errors: outcome.errors }, { status: 400 });
      case "duplicate":
        return Response.json(
          {
            accepted: false,
            duplicate: true,
            packet_id: outcome.packet_id,
            status: outcome.status,
          },
          { status: 200 },
        );
      default:
        return this.publishAccepted(outcome.packet, outcome.received_at);
    }
  }

  private handleBoardUpsert(body: string): Response {
    let packet: BoardPacket;
    try {
      packet = JSON.parse(body) as BoardPacket;
    } catch {
      return jsonError("malformed_payload", "Board upsert body was not JSON", 400);
    }
    if (typeof packet?.id !== "string" || packet.id === "" || typeof packet.stage !== "string") {
      return jsonError("invalid_board_packet", "Board upsert requires id and stage", 400);
    }
    this.setState(upsertBoardPacket(this.state, packet));
    return Response.json({ ok: true }, { status: 200 });
  }

  /**
   * Publish the new packet onto the board, start evaluation, acknowledge.
   */
  private publishAccepted(packet: Packet, receivedAt: string): Response {
    const agent = agentNameForPacket(packet);
    const chip = boardPacketFromIntake(packet, receivedAt);
    this.publishBoardPacket(chip);

    this.ctx.waitUntil(
      this.startEvaluate(packet).catch((error: unknown) => {
        console.error(`evaluation for packet ${packet.packet_id} did not start`, error);
      }),
    );

    return Response.json(
      {
        accepted: true,
        duplicate: false,
        packet_id: packet.packet_id,
        agent,
        stage: "accepted",
      },
      { status: 202 },
    );
  }

  protected async startEvaluate(packet: Packet): Promise<void> {
    await this.runWorkflow(
      EVALUATE_WORKFLOW,
      { packet },
      { metadata: { packet_id: packet.packet_id } },
    );
  }

  /**
   * Durable progress hook used by EvaluateWorkflow. Upserts the chip on this
   * instance and mirrors it to `board` when this is not already the board.
   */
  async applyBoardMilestone(milestone: EvaluateMilestone): Promise<void> {
    const next = applyMilestoneToBoard(this.state, milestone);
    const chip = next.packets.find((entry) => entry.id === milestone.packet_id);
    this.setState(next);
    if (chip) this.enqueueBoardMirror(chip);
  }

  /**
   * Board instance entry point for mirrors from per-service Agents.
   */
  async receiveBoardPacket(packet: BoardPacket): Promise<void> {
    this.setState(upsertBoardPacket(this.state, packet));
  }

  override async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown,
  ): Promise<void> {
    const evaluation = readEvaluateResult(result);
    if (evaluation === null) {
      console.error(`workflow ${workflowId} finished with a result this judge cannot read`);
      return;
    }

    this.publishOutcome(workflowId, { ok: true, result: evaluation });
  }

  override async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    const packetId = this.getWorkflow(workflowId)?.metadata?.packet_id;
    if (typeof packetId !== "string") {
      console.error(`workflow ${workflowId} failed for a packet this judge cannot name`, error);
      return;
    }

    this.publishOutcome(workflowId, { ok: false, packet_id: packetId, reason: error });
  }

  private publishOutcome(workflowId: string, outcome: EvaluationOutcome): void {
    if (persistEvaluation(sqlTag(this), outcome) === "unknown_packet") {
      const packetId = outcome.ok ? outcome.result.packet_id : outcome.packet_id;
      console.error(`workflow ${workflowId} finished for unknown packet ${packetId}`);
      return;
    }

    const next = outcome.ok
      ? applyTerminalToBoard(this.state, {
          packet_id: outcome.result.packet_id,
          ok: true,
          jev: outcome.result.jev,
          verdict: outcome.result.verdict?.verdict,
          llama_latency_ms: outcome.result.verdict?.latency_ms,
        })
      : applyTerminalToBoard(this.state, {
          packet_id: outcome.packet_id,
          ok: false,
        });

    const packetId = outcome.ok ? outcome.result.packet_id : outcome.packet_id;
    const chip = next.packets.find((entry) => entry.id === packetId);
    this.setState(next);
    if (chip) this.enqueueBoardMirror(chip);
  }

  /** Local setState + async mirror. */
  private publishBoardPacket(packet: BoardPacket): void {
    this.setState(upsertBoardPacket(this.state, packet));
    this.enqueueBoardMirror(packet);
  }

  private enqueueBoardMirror(packet: BoardPacket): void {
    if (this.name === BOARD_INSTANCE_NAME) return;
    this.ctx.waitUntil(
      this.mirrorToBoard(packet).catch((error: unknown) => {
        console.error(`board mirror failed for ${packet.id}`, error);
      }),
    );
  }

  private async mirrorToBoard(packet: BoardPacket): Promise<void> {
    if (this.name === BOARD_INSTANCE_NAME) return;
    // Prefer fetch over typed RPC: waitUntil mirrors must not deadlock the
    // accepting DO if the board stub is slow or the pool is single-threaded.
    const board = await getAgentByName<Env, OtelJudgeAgent>(
      this.env.OTEL_JUDGE_AGENT,
      BOARD_INSTANCE_NAME,
    );
    const response = await board.fetch("https://otel-judge.internal/board-upsert", {
      method: "POST",
      headers: { "content-type": "application/json", "x-otel-judge-board-upsert": "1" },
      body: JSON.stringify(packet),
    });
    if (!response.ok) {
      throw new Error(`board upsert returned ${response.status}`);
    }
  }

  @callable({ description: "List recent packets, newest first, with their verdict severity" })
  getHistory(limit: number = DEFAULT_HISTORY_LIMIT): HistoryRow[] {
    const sql = sqlTag(this);
    const summaries = listRecentPackets(sql, clampHistoryLimit(limit));
    const severities = verdictSeverities(
      sql,
      summaries.map((summary) => summary.packet_id),
    );

    return summaries.map((summary) => ({
      packet_id: summary.packet_id,
      service: summary.service,
      env: summary.env,
      window_start: summary.window_start,
      window_end: summary.window_end,
      received_at: summary.received_at,
      status: summary.status,
      severity: severities.get(summary.packet_id) ?? null,
    }));
  }

  @callable({ description: "Fetch one packet with its distributions, verdict, and labels" })
  getPacket(packetId: string): PacketDetail | null {
    const record = getPacketRecord(sqlTag(this), packetId);
    if (record === null) return null;

    return {
      packet: record.packet,
      jev_run: record.jev_run,
      jev_answers: record.answers,
      verdict: record.verdict,
      labels: record.labels,
    };
  }

  @callable({ description: "Attach a human label to a packet without altering its verdict" })
  labelPacket(packetId: string, label: string, note?: string | null): HumanLabel {
    if (!isHumanLabelName(label)) {
      throw new LabelRejectedError(
        "unknown_label",
        `${JSON.stringify(label)} is not a label; expected one of sev0, sev1, sev2, noise, wrong`,
      );
    }

    const text = note ?? null;
    if (text !== null && text.length > MAX_LABEL_NOTE_LENGTH) {
      throw new LabelRejectedError(
        "note_too_long",
        `note is ${text.length} characters; the limit is ${MAX_LABEL_NOTE_LENGTH}`,
      );
    }

    const sql = sqlTag(this);
    if (!hasPacket(sql, packetId)) {
      throw new LabelRejectedError("unknown_packet", `packet ${packetId} is not stored here`);
    }

    return recordHumanLabel(sql, packetId, label, text);
  }
}
