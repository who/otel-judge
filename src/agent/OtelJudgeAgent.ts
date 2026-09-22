import { Agent, callable } from "agents";
import type { Packet } from "../packet/types";
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
import { agentNameForPacket } from "./identity";
import {
  persistEvaluation,
  readEvaluateResult,
  terminalState,
  type EvaluationOutcome,
} from "./persist";
import { INITIAL_STATE, type JudgeState } from "./state";
import {
  countPackets,
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
 * The judge itself: one durable instance per service and environment.
 *
 * This class deliberately depends on nothing but the Agents SDK and its own
 * folder. Whatever carries a packet here — an HTTP door, a chat channel, a
 * scheduled replay — plugs into the same surface, and none of them can be
 * reached in the other direction.
 */
export class OtelJudgeAgent extends Agent<Env, JudgeState> {
  /** Copied per instance so two Agents can never share one snapshot object. */
  override initialState: JudgeState = { ...INITIAL_STATE };

  /**
   * The one designated place startup work is invoked.
   *
   * Tables first, then the counter: having exactly one hook means a cold start
   * never races two initialisation paths against each other. Both steps are
   * synchronous, so the Agent cannot answer a request before its storage is
   * ready and its snapshot tells the truth.
   *
   * The snapshot is only written when the stored count differs from what is
   * published. A freshly created Agent has nothing stored and therefore
   * broadcasts nothing, which is what keeps a cold instance identical to
   * `INITIAL_STATE`; `updated_at` is deliberately left alone because recovering
   * a count is not news about a packet.
   */
  override onStart(): void {
    const sql = sqlTag(this);
    ensureSchema(sql);

    const seen = countPackets(sql);
    if (seen !== this.state.packets_seen) {
      this.setState({ ...this.state, packets_seen: seen });
    }
  }

  /**
   * Take a packet, or say precisely why this one was not taken.
   *
   * An acknowledgement is worth having only if it arrives before the producer
   * has moved on, so everything between here and the response is bounded work:
   * one size check, one parse, one validation pass, one indexed read, one
   * insert, one snapshot. The evaluation that follows is the slow, fallible,
   * model-shaped part, and it is deliberately on the other side of the reply.
   *
   * A method other than POST is answered explicitly rather than falling through
   * to an opaque SDK default, because every caller that reaches an Agent is a
   * program that has to distinguish "wrong verb" from "wrong packet".
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

    let outcome: AcceptOutcome;
    try {
      outcome = acceptPacket({ sql: sqlTag(this) }, body);
    } catch {
      // The packet was valid and storage refused it anyway, so the fault is
      // this side of the wire and the producer is told to retry. The snapshot
      // is left alone on purpose: publishing `accepted` with no row behind it
      // would be a claim no later read could make good on.
      return jsonError("storage_failure", "The packet could not be stored; retry it", 500);
    }

    switch (outcome.kind) {
      case "too_large":
        return jsonError("packet_too_large", `Request body exceeds ${outcome.limit} bytes`, 413);
      case "invalid":
        // The whole error list goes back, not the first failure: a producer
        // fixing its integration should need one round trip, not one per field.
        return Response.json({ error: outcome.code, errors: outcome.errors }, { status: 400 });
      case "duplicate":
        // 200 rather than 409: the id the producer asked to have stored is
        // stored, so this is a successful no-op, and a conflict status would
        // put a retry loop in front of a packet that is already being judged.
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

  /**
   * Publish the new packet, start its evaluation, and acknowledge — in that order.
   *
   * The snapshot moves first so a client watching the socket learns of the
   * packet no later than the producer does. `packets_seen` is incremented from
   * the published value rather than re-counted, because the count was
   * reconciled against the table at start-up and one accepted packet is one
   * more; `agent_name` is filled in from the packet because a Durable Object is
   * constructed before it is told which name it answers to, and this is the
   * first moment anything names it.
   */
  private publishAccepted(packet: Packet, receivedAt: string): Response {
    const agent = agentNameForPacket(packet);

    this.setState({
      ...this.state,
      agent_name: agent,
      stage: "accepted",
      packets_seen: this.state.packets_seen + 1,
      last_packet_id: packet.packet_id,
      updated_at: receivedAt,
    });

    // Handed to the runtime instead of awaited: waiting here would put the
    // entire evaluation inside the producer's request, which is the shape this
    // whole path exists to avoid. `waitUntil` keeps the work alive after the
    // acknowledgement has gone back, and the catch is what stops a seam that
    // throws from surfacing as an unhandled rejection in an unrelated request.
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

  /**
   * The single place evaluation is started from.
   *
   * What is awaited is the start, never the run: `runWorkflow` resolves once
   * Workflows has taken the instance, and everything after that is durable
   * somewhere other than this request. The whole validated packet is the
   * payload, because a step retrying half an hour from now must not depend on
   * this Agent still being awake or still holding the row.
   *
   * The packet id also travels as workflow metadata, which is the only reason a
   * failure can be attributed later: a failed run has no result to read an id
   * out of, and the metadata is stored beside the tracking row rather than in
   * memory, so an Agent that was evicted and rehydrated can still say which
   * packet the failure belonged to.
   */
  protected async startEvaluate(packet: Packet): Promise<void> {
    await this.runWorkflow(
      EVALUATE_WORKFLOW,
      { packet },
      { metadata: { packet_id: packet.packet_id } },
    );
  }

  /**
   * Write the evaluation down, then say it is done — in that order.
   *
   * The order is a promise to clients: a browser that reacts to the `complete`
   * stage by asking for the packet's history must find the rows already there,
   * and the only way to guarantee that is to publish after the write rather
   * than beside it.
   *
   * Nothing in here reads anything the accept path left in memory. A workflow
   * can finish long after the Agent that started it was evicted, so the result
   * and storage are the whole of what a completion has to work from.
   */
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

  /**
   * Record that a run ended without a verdict, and publish the failed stage.
   *
   * A failure is history rather than an absence of it: the packet keeps a row
   * saying the attempt was made and stopped, which is what a human scanning the
   * board needs to tell "never judged" apart from "judged and quiet".
   */
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

  /**
   * The one path both endings share: persist, then publish.
   *
   * A completion naming a packet that was never stored here is logged and
   * dropped. It means a run was routed to the wrong instance, and the only
   * worse answer than losing it would be inventing the packet it is about.
   *
   * The snapshot is spread from the published one rather than rebuilt, so the
   * counter and the agent name a run has no opinion about survive it.
   */
  private publishOutcome(workflowId: string, outcome: EvaluationOutcome): void {
    if (persistEvaluation(sqlTag(this), outcome) === "unknown_packet") {
      const packetId = outcome.ok ? outcome.result.packet_id : outcome.packet_id;
      console.error(`workflow ${workflowId} finished for unknown packet ${packetId}`);
      return;
    }

    this.setState({ ...this.state, ...terminalState(outcome) } as JudgeState);
  }

  /**
   * The most recently received packets, newest first.
   *
   * This is the read a channel opens with, so it is the one that has to stay
   * cheap: a row carries the identity of a packet and the judge's conclusion
   * about it, never the payload, the distributions, or the prose. A caller that
   * wants any of those names a packet and asks for it.
   *
   * Nothing in here touches live state. A history query from one client must be
   * invisible to every other connected client, and the only way to promise that
   * is for the read path to have no `setState` on it at all.
   */
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

  /**
   * Everything stored about one packet, or null when this judge has no such id.
   *
   * An unknown id is answered rather than thrown on: a history page follows a
   * link to a packet that may have been judged by a different Agent or may
   * never have existed, and a channel should render an empty state for that
   * rather than an error dialog.
   *
   * The answers come back whole — full vector and noul mass per question — and
   * a single answer whose stored JSON no longer parses arrives as a failure in
   * the list instead of costing the caller the rest of the record.
   */
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

  /**
   * Attach a human's judgement to a packet, and hand back what was written.
   *
   * This is the single write path for a human opinion, whichever channel the
   * human is using, which is why the vocabulary is checked here rather than at
   * whatever door the click came through: a Slack app and a browser must not be
   * able to disagree about what counts as a label.
   *
   * Labelling deliberately re-runs nothing and overwrites nothing. The verdict
   * a model produced stays exactly as it was recorded, and the label sits
   * beside it, so replayed history shows both what the judge said and what a
   * human said back — which is the whole point of keeping `wrong` as a label.
   */
  @callable({ description: "Attach a human label to a packet without altering its verdict" })
  labelPacket(packetId: string, label: string, note?: string | null): HumanLabel {
    if (!isHumanLabelName(label)) {
      throw new LabelRejectedError(
        "unknown_label",
        `${JSON.stringify(label)} is not a label; expected one of sev0, sev1, sev2, noise, wrong`,
      );
    }

    // Rejected rather than truncated: a writer who loses the end of a sentence
    // silently has no way to learn that the note it reads back is not the one
    // it sent.
    const text = note ?? null;
    if (text !== null && text.length > MAX_LABEL_NOTE_LENGTH) {
      throw new LabelRejectedError(
        "note_too_long",
        `note is ${text.length} characters; the limit is ${MAX_LABEL_NOTE_LENGTH}`,
      );
    }

    // A label on an id this judge never stored would be a row no read can ever
    // reach, since `getPacket` answers null for that id.
    const sql = sqlTag(this);
    if (!hasPacket(sql, packetId)) {
      throw new LabelRejectedError("unknown_packet", `packet ${packetId} is not stored here`);
    }

    return recordHumanLabel(sql, packetId, label, text);
  }
}
