import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { agentNameForPacket, DEFAULT_AGENT_NAME, slug } from "../src/agent/identity";
import { INITIAL_STATE } from "../src/agent/state";

function judge(name: string) {
  return env.OTEL_JUDGE_AGENT.get(env.OTEL_JUDGE_AGENT.idFromName(name));
}

describe("naming", () => {
  it("sends two services in one environment to two Agents", () => {
    const checkout = agentNameForPacket({ env: "prod", service: "checkout" });
    const search = agentNameForPacket({ env: "prod", service: "search" });

    expect(checkout).toBe("prod:checkout");
    expect(search).toBe("prod:search");
    expect(checkout).not.toBe(search);
  });

  it("keeps one service in two environments apart", () => {
    expect(agentNameForPacket({ env: "staging", service: "checkout" })).not.toBe(
      agentNameForPacket({ env: "prod", service: "checkout" }),
    );
  });

  it("normalises hostile characters instead of passing them through", () => {
    expect(agentNameForPacket({ env: "PROD", service: "Cart API/v2" })).toBe("prod:cart-api-v2");
    expect(slug("a b\nc\td")).toBe("a-b-c-d");
    expect(slug("--lead--and--trail--")).toBe("lead-and-trail");
    expect(slug("naïve-café")).toBe("na-ve-caf");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
  });

  it("names an Agent unknown rather than nothing when a value slugs away", () => {
    expect(slug("!!!")).toBe("unknown");
    expect(slug("")).toBe("unknown");
    expect(agentNameForPacket({ env: "", service: "###" })).toBe("unknown:unknown");
  });

  it("truncates long names deterministically without colliding", () => {
    const shared = "a".repeat(60);
    const first = slug(`${shared}-one`);
    const second = slug(`${shared}-two`);

    expect(first.length).toBeLessThanOrEqual(48);
    expect(second.length).toBeLessThanOrEqual(48);
    expect(first).not.toBe(second);
    expect(slug(`${shared}-one`)).toBe(first);
    expect(first).toMatch(/^[a-z0-9-]+$/);
  });

  it("derives the default name out of nothing a producer controls", () => {
    expect(DEFAULT_AGENT_NAME).toBe("demo");
  });
});

describe("initial state", () => {
  it("publishes an empty BoardState on a cold Agent", async () => {
    const snapshot = await runInDurableObject(
      judge("cold-start"),
      (instance: OtelJudgeAgent) => instance.state,
    );

    expect(snapshot).toEqual(INITIAL_STATE);
    expect(snapshot.packets).toEqual([]);
    expect(snapshot.producer).toEqual({ scenario: "", ratePerSec: 0, paused: false });
    expect(snapshot.updatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("publishes a BoardState adaptAgentState would accept (packets array)", async () => {
    const snapshot = await runInDurableObject(
      judge("board-adapt"),
      (instance: OtelJudgeAgent) => instance.state,
    );
    expect(Array.isArray(snapshot.packets)).toBe(true);
    expect(snapshot).toHaveProperty("producer");
    expect(snapshot).toHaveProperty("updatedAt");
  });

  it("gives each Agent its own snapshot object to mutate", async () => {
    const shared = await runInDurableObject(
      judge("separate"),
      (instance: OtelJudgeAgent) => instance.initialState === INITIAL_STATE,
    );

    expect(shared).toBe(false);
  });
});

describe("direct requests", () => {
  it("answers an unsupported method with a JSON 405", async () => {
    const response = await SELF.fetch(`https://judge.test/agents/otel-judge-agent/${DEFAULT_AGENT_NAME}`);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({
      error: "method_not_allowed",
      message: expect.any(String),
    });
  });

  it("answers a POST it cannot accept with a JSON 400 and the error list", async () => {
    // An empty object is valid JSON, so this deliberately takes the validation
    // branch rather than the parse-failure one: the first thing validation
    // checks is the schema version, and an object without one is turned away
    // under that code. Nothing is stored for a rejected packet, so sharing the
    // default name with the 405 case leaves no state behind for either.
    const response = await SELF.fetch(
      `https://judge.test/agents/otel-judge-agent/${DEFAULT_AGENT_NAME}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: "unsupported_schema_version",
      errors: expect.arrayContaining([expect.stringMatching(/^schema_version: /)]),
    });
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
