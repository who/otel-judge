import { env, runInDurableObject } from "cloudflare:test";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import type { BoardState } from "../src/agent/boardState";
import { WORKFLOW_FAILED_REASON } from "../src/agent/persist";
import { getPacketRecord, getPacketStatus, sqlTag } from "../src/agent/store";
import type { JevResult } from "../src/jev/types";
import type { JudgeResult } from "../src/llm/judge";
import { validatePacket } from "../src/packet/validate";
import { runEvaluate, type EvaluateStep } from "../src/workflow/evaluate";
import { summarizePacket } from "../src/workflow/summarize";
import { loadFixture } from "./fixtures.test";

/**
 * What a connected client sees while one packet is judged, and what is kept.
 *
 * Live state is BoardState. Progress is applied through applyBoardMilestone —
 * the same path EvaluateWorkflow uses — so stage chips and jev/llama fields
 * match the demo wire contract.
 */

/** A step that runs its callback once and records board snapshots after each milestone. */
class RecordingStep implements EvaluateStep {
  readonly snapshots: BoardState[] = [];

  constructor(private readonly instance: OtelJudgeAgent) {}

  async do<T extends Rpc.Serializable<T>>(
    _name: string,
    _config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T> {
    return callback();
  }
}

/** One question answered with a full distribution, which is what has to survive to SQL. */
const JEV_OK: JevResult = {
  ok: true,
  answers: [
    {
      key: "severity",
      distribution: { sev0: 0.05, sev1: 0.62, sev2: 0.21, noise: 0.04 },
      noul: 0.08,
      argmax: { outcome: "sev1", p: 0.62 },
    },
  ],
  model: "jev-latest",
  latency_ms: 412,
};

/** A verdict with prose in every field, so a snapshot leaking one is detectable. */
const VERDICT: JudgeResult = {
  verdict: {
    severity: "sev1",
    summary: "Error rate tripled shortly after the 2.4.1 rollout.",
    critique: "The priors put most of their mass on a deploy cause and the spans agree.",
    next_action: "Roll back to 2.4.0 and re-measure the error rate.",
    confidence_note: "Confident: the window is short and the deploy is recent.",
    disagrees_with_prior: false,
    raw: '{"severity":"sev1"}',
  },
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  prompt: { system: "the standing judge instructions", user: "the summary and the priors" },
};

/** System One unreachable with nothing to retry: the run ends before the judge. */
const JEV_UNAVAILABLE: JevResult = { ok: false, retryable: false, reason: "missing_api_key" };

function fixturePacket() {
  const result = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!result.ok) throw new Error(`fixture failed validation: ${result.errors.join(" | ")}`);
  return result.packet;
}

function post(payload: unknown): Request {
  return new Request("https://judge.test/agents/otel-judge-agent/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function withAgent<T>(
  name: string,
  body: (instance: OtelJudgeAgent) => T | Promise<T>,
): Promise<T> {
  const stub = env.OTEL_JUDGE_AGENT.get(env.OTEL_JUDGE_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return body(instance);
  });
}

async function acceptFixture(instance: OtelJudgeAgent): Promise<string> {
  const response = await instance.onRequest(post(loadFixture("deploy-regression-sev1")));
  expect(response.status).toBe(202);

  for (let attempt = 0; attempt < 100; attempt++) {
    const workflowId = instance.getWorkflows({ workflowName: "EVALUATE_WORKFLOW" })
      .workflows[0]?.workflowId;
    if (workflowId !== undefined) return workflowId;
    await scheduler.wait(10);
  }
  throw new Error("accepting a packet started no workflow");
}

/** Run the pipeline against the Agent with both models stubbed. */
async function evaluate(
  instance: OtelJudgeAgent,
  step: RecordingStep,
  judge: () => Promise<JudgeResult> = async () => VERDICT,
  callSystemOne: () => Promise<JevResult> = async () => JEV_OK,
) {
  return runEvaluate(
    step,
    { packet: fixturePacket() },
    {
      summarize: summarizePacket,
      callSystemOne,
      judge,
      onProgress: async (milestone) => {
        await instance.applyBoardMilestone(milestone);
        step.snapshots.push({
          ...instance.state,
          packets: instance.state.packets.map((packet) => ({ ...packet })),
          producer: { ...instance.state.producer },
        });
      },
    },
  );
}

describe("a packet being judged", () => {
  it("moves board chips through ingest→jev→llama→verdict", async () => {
    await withAgent("progress-stages", async (instance) => {
      const workflowId = await acceptFixture(instance);
      expect(instance.state.packets[0]?.stage).toBe("ingest");

      const step = new RecordingStep(instance);
      const result = await evaluate(instance, step);
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      const stages = [
        ...step.snapshots.map((state) => state.packets.find((p) => p.id === result.packet_id)?.stage),
        instance.state.packets.find((p) => p.id === result.packet_id)?.stage,
      ];
      expect(stages).toEqual(["ingest", "jev", "llama", "verdict"]);

      const chip = instance.state.packets.find((p) => p.id === result.packet_id);
      expect(chip?.jev).toEqual({ sev0: 0.05, sev1: 0.62, sev2: 0.21, noise: 0.04 });
      expect(chip?.llama).toEqual({
        label: "flag",
        rationale: "Error rate tripled shortly after the 2.4.1 rollout.",
        actions: ["Roll back to 2.4.0 and re-measure the error rate."],
      });
      // A judged packet says nothing about a skip, so the marker stays off the wire.
      expect(chip?.jevUnavailable).toBeUndefined();
      expect(instance.state.packets).toHaveLength(1);
    });
  });

  it("published board state is the demo contract: packets, producer, updatedAt", async () => {
    await withAgent("progress-small", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const step = new RecordingStep(instance);
      const result = await evaluate(instance, step);
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      const observed = [...step.snapshots, { ...instance.state }];

      // Prompt / raw / confidence stay out of the broadcast; critique stays in SQL.
      const forbidden = [
        VERDICT.verdict.critique,
        VERDICT.verdict.confidence_note,
        VERDICT.verdict.raw,
        VERDICT.prompt.system,
        VERDICT.prompt.user,
        result.summary.log_digest,
      ];

      for (const snapshot of observed) {
        const published = JSON.stringify(snapshot);
        for (const secret of forbidden) {
          expect(published).not.toContain(secret);
        }

        expect(Object.keys(snapshot).sort()).toEqual(["packets", "producer", "updatedAt"]);
        expect(Array.isArray(snapshot.packets)).toBe(true);
        expect(snapshot.producer).toEqual(
          expect.objectContaining({
            scenario: expect.any(String),
            ratePerSec: expect.any(Number),
            paused: expect.any(Boolean),
          }),
        );
      }
    });
  });

  it("leaves the run, the whole answers, and one verdict persisted", async () => {
    await withAgent("progress-persist", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const step = new RecordingStep(instance);
      const result = await evaluate(instance, step);
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      const sql = sqlTag(instance);
      const record = getPacketRecord(sql, result.packet_id);
      expect(record?.packet.status).toBe("complete");
      expect(record?.jev_run).toMatchObject({ model: "jev-latest", status: "ok", latency_ms: 412 });

      expect(record?.answers).toEqual([
        {
          ok: true,
          question_key: "severity",
          created_at: expect.any(String),
          answer: {
            distribution: { sev0: 0.05, sev1: 0.62, sev2: 0.21, noise: 0.04 },
            noul: 0.08,
            argmax: { outcome: "sev1", p: 0.62 },
          },
        },
      ]);

      expect(record?.verdict).toMatchObject({
        severity: "sev1",
        critique: "The priors put most of their mass on a deploy cause and the spans agree.",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      });

      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);
      const replayed = getPacketRecord(sql, result.packet_id);
      expect(replayed?.answers).toHaveLength(1);
      expect(sql<{ total: number }>`SELECT COUNT(*) AS total FROM verdicts`[0]?.total).toBe(1);
    });
  });

  it("records the attempt when a judge failure ends the run", async () => {
    await withAgent("progress-failure", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const step = new RecordingStep(instance);
      const judgeFailed = evaluate(instance, step, async () => {
        throw new Error("the judge exhausted its retries");
      });
      await expect(judgeFailed).rejects.toThrow("the judge exhausted its retries");

      await instance.onWorkflowError(
        "EVALUATE_WORKFLOW",
        workflowId,
        "the judge exhausted its retries",
      );

      const packetId = fixturePacket().packet_id;
      expect(instance.state.packets.find((p) => p.id === packetId)?.stage).toBe("verdict");

      const sql = sqlTag(instance);
      expect(getPacketStatus(sql, packetId)).toBe("failed");

      const record = getPacketRecord(sql, packetId);
      expect(record?.jev_run).toMatchObject({
        model: null,
        status: "error",
        reason: WORKFLOW_FAILED_REASON,
      });
      expect(record?.verdict).toBeNull();
    });
  });

  it("marks the chip unavailable when no priors leave the judge unasked", async () => {
    await withAgent("progress-jev-unavailable", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const step = new RecordingStep(instance);
      const result = await evaluate(
        instance,
        step,
        async () => {
          throw new Error("the judge was asked without priors");
        },
        async () => JEV_UNAVAILABLE,
      );
      expect(result.verdict).toBeUndefined();

      // Mid-run the chip claims nothing: a System One that has just failed is
      // only a skipped System Two once the run is over.
      for (const snapshot of step.snapshots) {
        const live = snapshot.packets.find((p) => p.id === result.packet_id);
        expect(live?.jevUnavailable).toBeUndefined();
      }

      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      const chip = instance.state.packets.find((p) => p.id === result.packet_id);
      expect(chip?.stage).toBe("verdict");
      expect(chip?.jevUnavailable).toBe(true);
      expect(chip?.llama).toBeUndefined();
      expect(chip?.jev).toBeUndefined();
    });
  });

  it("drops the unavailable marker once a later run reaches a verdict", async () => {
    await withAgent("progress-jev-recovered", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const skipped = await evaluate(
        instance,
        new RecordingStep(instance),
        async () => {
          throw new Error("the judge was asked without priors");
        },
        async () => JEV_UNAVAILABLE,
      );
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, skipped);
      expect(
        instance.state.packets.find((p) => p.id === skipped.packet_id)?.jevUnavailable,
      ).toBe(true);

      const judged = await evaluate(instance, new RecordingStep(instance));
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, judged);

      const chip = instance.state.packets.find((p) => p.id === judged.packet_id);
      expect(chip?.jevUnavailable).toBeUndefined();
      expect(chip?.llama?.label).toBe("flag");
    });
  });

  it("refuses a completion for a packet it has never stored", async () => {
    await withAgent("progress-unknown", async (instance) => {
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", "wf-stray", {
        packet_id: "never-accepted",
        summary: {},
        jev: JEV_OK,
        verdict: VERDICT,
      });

      const sql = sqlTag(instance);
      expect(getPacketRecord(sql, "never-accepted")).toBeNull();
      expect(instance.state.packets).toEqual([]);
    });
  });
});
