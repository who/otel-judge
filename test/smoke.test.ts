import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("reaches the Worker fetch handler", async () => {
  const response = await SELF.fetch("https://example.com/");

  expect(response).toBeInstanceOf(Response);
  await response.text();
});

it("binds the Agent Durable Object namespace", () => {
  expect(env.OTEL_JUDGE_AGENT).toBeDefined();
  const id = env.OTEL_JUDGE_AGENT.idFromName("smoke");
  expect(env.OTEL_JUDGE_AGENT.get(id)).toBeDefined();
});
