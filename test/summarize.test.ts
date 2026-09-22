import { describe, expect, it } from "vitest";
import type { SystemOneState } from "../src/jev/request";
import type { Packet } from "../src/packet/types";
import { validatePacket } from "../src/packet/validate";
import {
  LADDER_ALERT_LABELS,
  MAX_SPAN_NAME_CHARS,
  MAX_SUMMARY_BYTES,
  MIN_WINDOW_MINUTES,
  SummaryTooLargeError,
  pctDelta,
  summarizePacket,
  type PacketSummary,
} from "../src/workflow/summarize";
import { loadFixture, type FixtureName } from "./fixtures.test";

/**
 * The summarizer is given packets, not payloads.
 *
 * Every input here goes through `validatePacket` first for the same reason the
 * Agent does: a fixture earns the name packet by being accepted, and a test that
 * summarised a payload the door would have refused would be proving something
 * about a packet that can never arrive.
 */
function accepted(name: FixtureName): Packet {
  const result = validatePacket(loadFixture(name));
  if (!result.ok) throw new Error(`${name} failed validation: ${result.errors.join(" | ")}`);
  return result.packet;
}

/** The size the cap is written in terms of, measured the way the summarizer measures it. */
function bytesOf(summary: PacketSummary): number {
  return new TextEncoder().encode(JSON.stringify(summary)).byteLength;
}

/** Distinct labels of a given length, which is the cheapest way to inflate a packet. */
function labels(count: number, length: number): string[] {
  return Array.from({ length: count }, (_, index) => `${index}`.padEnd(length, "-label"));
}

describe("summarizePacket", () => {
  it("computes the deploy-regression deltas, saturation peak, deploy recency and error spans", () => {
    const summary = summarizePacket(accepted("deploy-regression-sev1"));

    expect(summary.packet_id).toBe("fix-deploy-regression-001");
    expect(summary.service).toBe("checkout");
    expect(summary.window_minutes).toBe(5);
    // 0.004 to 0.21 is a little over fifty times baseline, and the judge is
    // handed that number rather than the two rates and a hope.
    expect(summary.error_rate_delta_pct).toBe(5150);
    expect(summary.p95_latency_delta_pct).toBe(391.7);
    expect(summary.baseline_missing).toBe(false);
    // Nothing measured resource pressure, which is absence rather than calm.
    expect(summary.saturation_peak_pct).toBeNull();
    expect(summary.queue_depth).toBeNull();
    expect(summary.deploy_minutes_ago).toBe(7);
    expect(summary.deploy_version).toBe("checkout@2026.01.14-3");
    // Ranked by errors, not by traffic: `cart.load` is the busiest span in the
    // packet and the least interesting thing in it.
    expect(summary.top_error_spans).toEqual([
      { name: "POST /checkout/submit", count: 9420, error_count: 1834, error_share: 0.52 },
      { name: "payments.authorize", count: 9118, error_count: 1702, error_share: 0.48 },
      { name: "cart.load", count: 9604, error_count: 11, error_share: 0 },
    ]);
    expect(summary.alert_labels).toEqual(["checkout", "http-5xx", "sev1"]);
    expect(summary.log_digest).toContain("circuit breaker payments-authorize opened");
    expect(summary.log_digest.split("\n")).toHaveLength(2);

    // The compatibility constraint, checked by the compiler rather than asserted
    // in prose: the summary is the state the request builder is handed, and an
    // unassignable shape would be a typecheck failure here first.
    const state: SystemOneState = summary;
    expect(state.packet_id).toBe("fix-deploy-regression-001");
  });

  it("returns a null delta and flags a zero baseline instead of an infinite one", () => {
    const payload = loadFixture("deploy-regression-sev1") as Record<string, unknown>;
    const signals = payload.signals as Record<string, number>;
    signals.error_rate_baseline = 0;
    signals.p95_latency_baseline_ms = 0;

    const result = validatePacket(payload);
    if (!result.ok) throw new Error(`cold-start packet was refused: ${result.errors.join(" | ")}`);
    const summary = summarizePacket(result.packet);

    expect(summary.error_rate_delta_pct).toBeNull();
    expect(summary.p95_latency_delta_pct).toBeNull();
    expect(summary.baseline_missing).toBe(true);
    // The measurements themselves are untouched: only the comparison is missing.
    expect(summary.error_rate).toBe(0.21);
    expect(summary.p95_latency_ms).toBe(1180);

    expect(pctDelta(0.21, 0)).toBeNull();
    expect(pctDelta(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(pctDelta(Number.NaN, 1)).toBeNull();
    expect(pctDelta(0.5, 0.5)).toBe(0);
    expect(pctDelta(240, 1180)).toBe(-79.7);
  });

  it("keeps exemplar trace ids out of every fixture summary and under the byte cap", () => {
    for (const name of ["deploy-regression-sev1", "noise-flap", "saturation-sev0"] as const) {
      const packet = accepted(name);
      const summary = summarizePacket(packet);
      const json = JSON.stringify(summary);

      expect(packet.exemplar_trace_ids.length).toBeGreaterThan(0);
      for (const id of packet.exemplar_trace_ids) expect(json).not.toContain(id);
      expect(json).not.toContain("exemplar");
      expect(bytesOf(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    }
  });

  it("walks the reduction ladder to fit the cap and refuses to truncate past it", () => {
    const base = accepted("saturation-sev0");
    const bare = summarizePacket({ ...base, alert_labels: [], log_snippets: [] });
    const withDigest = summarizePacket({ ...base, alert_labels: [] });
    const digestBytes = bytesOf(withDigest) - bytesOf(bare);
    expect(digestBytes).toBeGreaterThan(0);

    // Sized so the digest is the only thing over the cap: the ladder should stop
    // at its first rung with the spans and labels still whole.
    const room = MAX_SUMMARY_BYTES - bytesOf(bare) - Math.floor(digestBytes / 2);
    const oneLabel = ["f".repeat(room - 3)];
    const chatty = summarizePacket({ ...base, alert_labels: oneLabel });

    expect(chatty.log_digest).toBe("");
    expect(chatty.alert_labels).toEqual(oneLabel);
    expect(chatty.top_error_spans).toHaveLength(3);
    expect(bytesOf(chatty)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);

    // Far enough over that every rung is needed, and the measurements survive
    // all three: the ladder gives up colour, never signal.
    const noisy = summarizePacket({ ...base, alert_labels: labels(20, 250) });

    expect(noisy.log_digest).toBe("");
    expect(noisy.top_error_spans).toHaveLength(1);
    expect(noisy.top_error_spans[0]?.name).toBe("payments.authorize");
    expect(noisy.alert_labels).toHaveLength(LADDER_ALERT_LABELS);
    expect(noisy.error_rate).toBe(0.47);
    expect(noisy.slo_burn_rate).toBe(14.2);
    expect(noisy.saturation_peak_pct).toBe(97);
    expect(noisy.queue_depth).toBe(8400);
    expect(bytesOf(noisy)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);

    const hopeless: Packet = { ...base, alert_labels: labels(LADDER_ALERT_LABELS, 5000) };
    let refusal: unknown;
    try {
      summarizePacket(hopeless);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(SummaryTooLargeError);
    expect((refusal as SummaryTooLargeError).packetId).toBe("fix-saturation-sev0-001");
    expect((refusal as SummaryTooLargeError).bytes).toBeGreaterThan(MAX_SUMMARY_BYTES);
    expect((refusal as SummaryTooLargeError).limit).toBe(MAX_SUMMARY_BYTES);
  });

  it("is byte-identical across two runs over the same packet", () => {
    const packet = accepted("noise-flap");
    expect(JSON.stringify(summarizePacket(packet))).toBe(JSON.stringify(summarizePacket(packet)));
  });
});

describe("an awkward packet", () => {
  it("summarises no spans, no deploy and a window measured in seconds", () => {
    const packet: Packet = {
      ...accepted("noise-flap"),
      window: { start: "2026-01-14T11:00:00Z", end: "2026-01-14T11:00:01Z" },
      top_spans: [],
      alert_labels: [],
    };
    delete packet.log_snippets;
    const summary = summarizePacket(packet);

    expect(summary.top_error_spans).toEqual([]);
    // A one-second window rounds to zero at one decimal place, and a zero-length
    // window would tell the judge every rate in the packet is meaningless.
    expect(summary.window_minutes).toBe(MIN_WINDOW_MINUTES);
    expect(summary.deploy_minutes_ago).toBeNull();
    expect(summary.deploy_version).toBeNull();
    expect(summary.log_digest).toBe("");
  });

  it("drops spans that carry traffic but no errors", () => {
    const base = accepted("noise-flap");
    const summary = summarizePacket({
      ...base,
      top_spans: [
        { name: "cache.get", count: 99_000, error_count: 0, p95_ms: 4 },
        { name: "index.query", count: 12, error_count: 3, p95_ms: 118 },
      ],
    });

    expect(summary.top_error_spans).toEqual([
      { name: "index.query", count: 12, error_count: 3, error_share: 1 },
    ]);
  });

  it("cuts unicode names and snippets between characters, never through one", () => {
    const base = accepted("noise-flap");
    const name = "🔥".repeat(200);
    const summary = summarizePacket({
      ...base,
      top_spans: [{ name, count: 10, error_count: 10, p95_ms: 20 }],
      log_snippets: ["🧵".repeat(400)],
    });

    const cut = summary.top_error_spans[0]?.name ?? "";
    expect([...cut]).toHaveLength(MAX_SPAN_NAME_CHARS);
    expect(cut).toBe([...name].slice(0, MAX_SPAN_NAME_CHARS).join(""));
    // A surrogate pair split in half survives `JSON.stringify` and reappears as
    // a replacement character on the wire, so the round trip is the real check.
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect([...summary.log_digest]).toHaveLength(200);
  });
});
