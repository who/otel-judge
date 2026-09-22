import { env, runInDurableObject } from "cloudflare:test";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { WORKFLOW_FAILED_REASON } from "../src/agent/persist";
import type { JudgeState } from "../src/agent/state";
import { getPacketRecord, getPacketStatus, sqlTag } from "../src/agent/store";
import type { JevResult } from "../src/jev/types";
import type { JudgeResult } from "../src/llm/judge";
import { validatePacket } from "../src/packet/validate";
import { runEvaluate, milestoneState, type EvaluateStep } from "../src/workflow/evaluate";
import { summarizePacket } from "../src/workflow/summarize";
import { loadFixture } from "./fixtures.test";

/**
 * What a connected client sees while one packet is judged, and what is kept.
 *
 * The workflow engine is the one thing faked here. A `WorkflowEntrypoint` cannot
 * be driven from a test, so the pipeline is run with a step object that calls
 * its callbacks and forwards each milestone through the same Agent RPC the real
 * step wrapper uses, and the run's ending is delivered through the same public
 * completion and error callbacks the engine would invoke. Everything between
 * the two — which stages appear, what is allowed into a broadcast snapshot, and
 * which rows exist afterwards — is this repository's own code.
 *
 * The two model-shaped steps are stubs. Every assertion below is about what the
 * judge does with an answer, and a live model would spend a minute per case to
 * prove nothing a fixed answer does not.
 */

/** A step that runs its callback once and reports milestones the way the real one does. */
class RecordingStep implements EvaluateStep {
  readonly snapshots: JudgeState[] = [];

  constructor(private readonly instance: OtelJudgeAgent) {}

  async do<T extends Rpc.Serializable<T>>(
    _name: string,
    _config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T> {
    return callback();
  }

  /** The merge the wrapped step performs, plus a copy of what a client would now hold. */
  async mergeAgentState(partial: Record<string, unknown>): Promise<void> {
    await this.instance._workflow_updateState("merge", partial);
    this.snapshots.push({ ...this.instance.state });
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

/**
 * Reach one Agent directly, as the accept tests do.
 *
 * `onStart` is called by hand because an instance reached this way skips the
 * lifecycle that would have created its tables on a first real request.
 */
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

/**
 * Accept the fixture and hand back the workflow the accept path started.
 *
 * The id is read out of the Agent's own tracking rather than passed in, because
 * recovering it is exactly what a real completion callback has to do, and a test
 * that supplied one would skip the part that can be wrong.
 */
async function acceptFixture(instance: OtelJudgeAgent): Promise<string> {
  const response = await instance.onRequest(post(loadFixture("deploy-regression-sev1")));
  expect(response.status).toBe(202);

  // The acknowledgement deliberately goes back before the workflow is started,
  // so the tracking row appears after the response rather than with it. Waiting
  // for it here is the test standing in for the runtime that outlives a request.
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
) {
  return runEvaluate(
    step,
    { packet: fixturePacket() },
    {
      summarize: summarizePacket,
      callSystemOne: async () => JEV_OK,
      judge,
      onProgress: (milestone) => step.mergeAgentState(milestoneState(milestone)),
    },
  );
}

describe("a packet being judged", () => {
  it("moves live state through its stages in order and ends complete", async () => {
    await withAgent("progress-stages", async (instance) => {
      const workflowId = await acceptFixture(instance);
      expect(instance.state.stage).toBe("accepted");

      const step = new RecordingStep(instance);
      const result = await evaluate(instance, step);
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      // Nothing here asked storage what stage the packet was in: every one of
      // these arrived at a client because the Agent pushed it.
      expect([...step.snapshots.map((state) => state.stage), instance.state.stage]).toEqual([
        "summarized",
        "jev",
        "judging",
        "complete",
      ]);

      expect(instance.state.last_packet_id).toBe(result.packet_id);
      expect(instance.state.jev_status).toBe("ok");
      expect(instance.state.last_verdict).toEqual({
        severity: "sev1",
        summary: "Error rate tripled shortly after the 2.4.1 rollout.",
      });

      // The accept path's counter is the Agent's, not the run's, and a merge
      // that reset it would be a snapshot telling a browser history was lost.
      expect(instance.state.packets_seen).toBe(1);
      expect(instance.state.agent_name).toBe("prod:checkout");
    });
  });

  it("published state stays small: no distribution, prompt, or critique crosses", async () => {
    await withAgent("progress-small", async (instance) => {
      const workflowId = await acceptFixture(instance);

      const step = new RecordingStep(instance);
      const result = await evaluate(instance, step);
      await instance.onWorkflowComplete("EVALUATE_WORKFLOW", workflowId, result);

      const observed = [...step.snapshots, { ...instance.state }];

      // The mass on an outcome, the mass on none of them, the prose the judge
      // wrote to explain itself, the reply it wrote them in, and the text it was
      // asked with: everything a deliberate history read exists to hand over.
      const forbidden = [
        "0.62",
        "sev2",
        "noul",
        "distribution",
        VERDICT.verdict.critique,
        VERDICT.verdict.next_action,
        VERDICT.verdict.confidence_note,
        VERDICT.verdict.raw,
        VERDICT.prompt.system,
        VERDICT.prompt.user,
        result.summary.log_digest,
        String(result.summary.slo_burn_rate),
      ];

      for (const snapshot of observed) {
        const published = JSON.stringify(snapshot);
        for (const secret of forbidden) {
          expect(published).not.toContain(secret);
        }

        // Named rather than counted, so a field added to the snapshot has to be
        // considered here before it reaches a public origin.
        expect(Object.keys(snapshot).sort()).toEqual([
          "agent_name",
          "jev_status",
          "last_packet_id",
          "last_verdict",
          "packets_seen",
          "stage",
          "updated_at",
        ]);
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

      // The vector, not its argmax: System Two reasoned over the whole
      // distribution and history has to be able to show what it saw.
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

      // Workflows redelivers; a second completion must not double the history.
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

      // The engine reports the failure with an id and no result, so the packet
      // it belonged to has to come back out of the workflow's own metadata.
      await instance.onWorkflowError(
        "EVALUATE_WORKFLOW",
        workflowId,
        "the judge exhausted its retries",
      );

      const packetId = fixturePacket().packet_id;
      expect(instance.state.stage).toBe("failed");
      expect(instance.state.last_packet_id).toBe(packetId);

      const sql = sqlTag(instance);
      expect(getPacketStatus(sql, packetId)).toBe("failed");

      // History shows an attempt that stopped, which is the thing a reader
      // needs to tell apart from a packet nobody ever looked at.
      const record = getPacketRecord(sql, packetId);
      expect(record?.jev_run).toMatchObject({
        model: null,
        status: "error",
        reason: WORKFLOW_FAILED_REASON,
      });
      expect(record?.verdict).toBeNull();
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
      expect(instance.state.stage).toBe("idle");
    });
  });
});
