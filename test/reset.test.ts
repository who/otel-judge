import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OtelJudgeAgent } from "../src/agent/OtelJudgeAgent";
import { BOARD_INSTANCE_NAME, type BoardPacket, type BoardState } from "../src/agent/boardState";
import { countPackets, insertPacket, sqlTag } from "../src/agent/store";
import { RESET_PATH } from "../src/ingress/reset";
import { validatePacket } from "../src/packet/validate";
import { handleRequest } from "../src/worker/router";
import { loadFixture } from "./fixtures.test";

/**
 * The local-demo wipe, exercised through the door rather than the Agent method,
 * because the thing being proved is that a public POST clears the board on a
 * deployment that opted in and changes nothing at all on one that did not. The
 * gate is a var, so each case is the same request against a differently
 * configured deployment.
 */
const DEMO_ORIGIN = "https://who.github.io";

/**
 * The same bindings with the reset gate in a chosen position.
 *
 * `wrangler types` pins the var to the literal wrangler.jsonc sets, which makes
 * the switched-off deployments unwritable without the assertion: they are the
 * production shape this test exists to cover, not a shape the local config has.
 */
function deployment(gate: string | undefined): Env {
  const { ALLOW_BOARD_RESET: _local, ...bindings } = env;
  return (gate === undefined ? bindings : { ...bindings, ALLOW_BOARD_RESET: gate }) as Env;
}

function board() {
  const namespace = env.OTEL_JUDGE_AGENT;
  return namespace.get(namespace.idFromName(BOARD_INSTANCE_NAME));
}

/** A chip shaped like one a mirror would have left behind. */
function chip(id: string): BoardPacket {
  return {
    id,
    stage: "ingest",
    receivedAt: "2026-09-22T12:00:00.000Z",
    summary: { service: "checkout", operation: "POST /checkout", durationMs: 412, statusCode: 500 },
  };
}

/** Put a chip on the board and a packet in the table behind it, as a run would. */
async function seedBoard(packetId: string): Promise<void> {
  const result = validatePacket(loadFixture("deploy-regression-sev1"));
  if (!result.ok) throw new Error(`fixture failed validation: ${result.errors.join(" | ")}`);
  const packet = { ...result.packet, packet_id: packetId };

  await runInDurableObject(board(), async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    await instance.receiveBoardPacket(chip(packetId));
    insertPacket(sqlTag(instance), packet, "2026-09-22T12:00:00.000Z");
  });
}

function boardState(): Promise<BoardState> {
  return runInDurableObject(board(), (instance: OtelJudgeAgent) => instance.state);
}

function storedPackets(): Promise<number> {
  return runInDurableObject(board(), async (instance: OtelJudgeAgent) => {
    await instance.onStart();
    return countPackets(sqlTag(instance));
  });
}

/** The request the demo's Reset button sends, against one configured deployment. */
async function reset(configured: Env, method = "POST"): Promise<Response> {
  const request = new Request(`https://judge.test${RESET_PATH}`, {
    method,
    headers: { origin: DEMO_ORIGIN },
  });
  const ctx = createExecutionContext();
  const response = await handleRequest(request, configured, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("a deployment that allows the board to be cleared", () => {
  it("empties the chips a watching demo is drawing", async () => {
    await seedBoard("reset-chips-001");
    expect((await boardState()).packets.length).toBeGreaterThan(0);

    const response = await reset(deployment("1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: true });
    const after = await boardState();
    expect(after.packets).toEqual([]);
    expect(after.producer).toEqual({ scenario: "", ratePerSec: 0, paused: false });
  });

  it("empties the stored history the board was drawn from", async () => {
    await seedBoard("reset-history-001");
    expect(await storedPackets()).toBeGreaterThan(0);

    const response = await reset(deployment("1"));

    expect(response.status).toBe(200);
    expect(await storedPackets()).toBe(0);
  });

  it("answers the browser with the headers that let it read the reply", async () => {
    const response = await reset(deployment("1"));

    expect(response.headers.get("access-control-allow-origin")).toBe(DEMO_ORIGIN);
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("leaves any other method on the path to the router's 404", async () => {
    await seedBoard("reset-method-001");

    const response = await reset(deployment("1"), "GET");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", message: expect.any(String) });
    expect((await boardState()).packets.map((packet) => packet.id)).toContain("reset-method-001");
  });
});

describe("a deployment that did not ask for a reset route", () => {
  it("refuses the wipe when the gate is switched off", async () => {
    await seedBoard("reset-gated-001");

    const response = await reset(deployment("0"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "reset_disabled", message: expect.any(String) });
    expect((await boardState()).packets.map((packet) => packet.id)).toContain("reset-gated-001");
    expect(await storedPackets()).toBeGreaterThan(0);
  });

  it("refuses the wipe when the var was never set at all", async () => {
    await seedBoard("reset-unset-001");

    const response = await reset(deployment(undefined));

    expect(response.status).toBe(403);
    expect((await boardState()).packets.map((packet) => packet.id)).toContain("reset-unset-001");
    expect(await storedPackets()).toBeGreaterThan(0);
  });
});
