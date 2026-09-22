import { describe, expect, it } from "vitest";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { JevResult } from "../src/jev/types";
import type { JudgeResult } from "../src/llm/judge";
import type { Packet } from "../src/packet/types";
import { validatePacket } from "../src/packet/validate";
import {
  runEvaluate,
  STEP_NAMES,
  STEP_RETRIES,
  type EvaluateDeps,
  type EvaluateMilestone,
  type EvaluateStep,
} from "../src/workflow/evaluate";
import { summarizePacket, SummaryTooLargeError, type PacketSummary } from "../src/workflow/summarize";
import { loadFixture } from "./fixtures.test";

/**
 * The orchestration is tested with a fake step and real arithmetic.
 *
 * `summarizePacket` is pure, so the happy path uses the real one and the
 * assertions below are about a summary this repository actually produces. The
 * two model-shaped dependencies are stubs, because every rule under test is a
 * rule about what the pipeline does with an answer, and a live model would spend
 * a minute per assertion to prove nothing the stub does not.
 */

/** One recorded invocation of the fake step, with the attempts it took. */
interface FakeCall {
  name: string;
  config: WorkflowStepConfig;
  attempts: number;
}

/**
 * A workflow step with the retry loop and none of the waiting.
 *
 * The real engine sleeps between attempts; this one does not, which is the only
 * way retry exhaustion is assertable in a test that finishes. Nothing else is
 * simplified: a callback that throws is retried up to its configured limit, and
 * the last error is what the caller sees, exactly as a spent budget behaves.
 */
class FakeStep implements EvaluateStep {
  readonly calls: FakeCall[] = [];

  async do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T> {
    const call: FakeCall = { name, config, attempts: 0 };
    this.calls.push(call);

    const limit = config.retries?.limit ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= limit; attempt++) {
      call.attempts += 1;
      try {
        return await callback();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

function packetOf(): Packet {
  const result = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!result.ok) throw new Error(`fixture failed validation: ${result.errors.join(" | ")}`);
  return result.packet;
}

/** A verdict shaped exactly as the parser hands one over, with nothing surprising in it. */
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
  prompt: { system: "system message", user: "user message" },
};

/** A System One call that answered, with one question's distribution on it. */
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

/** What each dependency was handed, so the pipeline's wiring can be asserted rather than assumed. */
interface Recorder {
  deps: EvaluateDeps;
  jevStates: PacketSummary[];
  judged: { summary: PacketSummary; jev: JevResult }[];
  milestones: EvaluateMilestone[];
}

function recorder(
  systemOne: () => Promise<JevResult>,
  judge: (summary: PacketSummary, jev: JevResult) => Promise<JudgeResult> = async () => VERDICT,
): Recorder {
  const jevStates: PacketSummary[] = [];
  const judged: { summary: PacketSummary; jev: JevResult }[] = [];
  const milestones: EvaluateMilestone[] = [];

  return {
    jevStates,
    judged,
    milestones,
    deps: {
      summarize: summarizePacket,
      callSystemOne: async (state) => {
        jevStates.push(state as PacketSummary);
        return systemOne();
      },
      judge: async (summary, jev) => {
        judged.push({ summary, jev });
        return judge(summary, jev);
      },
      onProgress: (milestone) => {
        milestones.push(milestone);
      },
    },
  };
}

describe("runEvaluate", () => {
  it("runs the happy path in order and returns every step's output", async () => {
    const step = new FakeStep();
    const { deps, jevStates, judged, milestones } = recorder(async () => JEV_OK);
    const packet = packetOf();

    const result = await runEvaluate(step, { packet }, deps);

    expect(step.calls.map((call) => call.name)).toEqual([...STEP_NAMES]);
    expect(step.calls.map((call) => call.attempts)).toEqual([1, 1, 1]);

    expect(result.packet_id).toBe(packet.packet_id);
    expect(result.summary).toEqual(summarizePacket(packet));
    expect(result.jev).toEqual(JEV_OK);
    expect(result.verdict).toEqual(VERDICT);
    expect(result.failed_at).toBeUndefined();

    // System One and the judge both reason over the summary the code computed,
    // never over the packet: the whole point of the first step is that nothing
    // downstream sees a raw signal again.
    expect(jevStates).toEqual([result.summary]);
    expect(judged).toEqual([{ summary: result.summary, jev: JEV_OK }]);

    // The jev milestone is the one that carries a status, because whether
    // priors exist is what a watching client needs at that boundary rather than
    // two steps later.
    expect(milestones).toEqual([
      { packet_id: packet.packet_id, step: "summarize", stage: "summarized" },
      { packet_id: packet.packet_id, step: "jev", stage: "jev", jev_status: "ok" },
      { packet_id: packet.packet_id, step: "judge", stage: "judging" },
    ]);
  });

  it("stops before the judge when System One cannot be asked at all", async () => {
    const step = new FakeStep();
    const unavailable: JevResult = { ok: false, retryable: false, reason: "missing_api_key" };
    const { deps, judged, milestones } = recorder(async () => unavailable);

    const result = await runEvaluate(step, { packet: packetOf() }, deps);

    // One attempt, not three: the client has already decided that no number of
    // tries configures a secret, and there is no judge left downstream to delay.
    expect(step.calls.map((call) => ({ name: call.name, attempts: call.attempts }))).toEqual([
      { name: "summarize", attempts: 1 },
      { name: "jev", attempts: 1 },
    ]);
    expect(result.jev).toEqual(unavailable);
    expect(result.failed_at).toBe("jev");

    // No verdict and no call: System Two reasons from the priors, so a packet
    // with none gets no opinion rather than an ungrounded one, and the run
    // reports where it stopped instead of fabricating what it never obtained.
    expect(result.verdict).toBeUndefined();
    expect(judged).toHaveLength(0);
    expect(milestones.map((milestone) => milestone.step)).toEqual(["summarize", "jev"]);
  });

  it("stops before the judge when System One exhausts its budget", async () => {
    const step = new FakeStep();
    const flaky: JevResult = { ok: false, retryable: true, reason: "timed out after 10000ms", status: 504 };
    const { deps, judged } = recorder(async () => flaky);

    const result = await runEvaluate(step, { packet: packetOf() }, deps);

    const jevCall = step.calls.find((call) => call.name === "jev");
    expect(jevCall?.attempts).toBe(3);

    // The run resolves rather than aborting, so the packet's history still says
    // what was tried. A spent retry budget is a missing prior all the same, and
    // nothing invents one to keep the judge busy.
    expect(result.jev).toEqual(flaky);
    expect(result.failed_at).toBe("jev");
    expect(result.verdict).toBeUndefined();
    expect(judged).toHaveLength(0);
    expect(step.calls.some((call) => call.name === "judge")).toBe(false);
  });

  it("stops with a readable reason when the System One step throws", async () => {
    const step = new FakeStep();
    const { deps, judged } = recorder(async () => {
      throw new Error("socket hung up");
    });

    const result = await runEvaluate(step, { packet: packetOf() }, deps);

    expect(result.jev).toEqual({ ok: false, retryable: false, reason: "socket hung up" });
    expect(result.failed_at).toBe("jev");
    expect(result.verdict).toBeUndefined();
    expect(judged).toHaveLength(0);
  });

  it("fails the workflow when the judge is still failing after its retries", async () => {
    const step = new FakeStep();
    const { deps } = recorder(
      async () => JEV_OK,
      async () => {
        throw new Error("Workers AI is overloaded");
      },
    );

    await expect(runEvaluate(step, { packet: packetOf() }, deps)).rejects.toThrow(
      "Workers AI is overloaded",
    );

    const judgeCall = step.calls.find((call) => call.name === "judge");
    expect(judgeCall?.attempts).toBe(3);
  });

  it("gives summarize no retries and both model steps their documented backoff", async () => {
    expect(STEP_RETRIES.summarize).toEqual({ retries: { limit: 0, delay: 0 } });
    expect(STEP_RETRIES.jev).toEqual({
      retries: { limit: 2, delay: "1 second", backoff: "exponential" },
    });
    expect(STEP_RETRIES.judge).toEqual({
      retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
    });

    // The configuration is only worth anything if the call sites use it, so the
    // run is asserted against the same table rather than against three literals.
    const step = new FakeStep();
    await runEvaluate(step, { packet: packetOf() }, recorder(async () => JEV_OK).deps);
    expect(step.calls.map((call) => call.config)).toEqual([
      STEP_RETRIES.summarize,
      STEP_RETRIES.jev,
      STEP_RETRIES.judge,
    ]);
  });

  it("fails fast without retrying when the summary is over its cap", async () => {
    const step = new FakeStep();
    const { deps, judged } = recorder(async () => JEV_OK);
    const packet = packetOf();

    await expect(
      runEvaluate(step, { packet }, {
        ...deps,
        summarize: () => {
          throw new SummaryTooLargeError(packet.packet_id, 9001);
        },
      }),
    ).rejects.toBeInstanceOf(SummaryTooLargeError);

    // A deterministic function fails the same way every time, so one attempt is
    // the whole of what retrying could have learned, and nothing downstream ran.
    expect(step.calls).toHaveLength(1);
    expect(step.calls[0]?.attempts).toBe(1);
    expect(judged).toHaveLength(0);
  });
});
