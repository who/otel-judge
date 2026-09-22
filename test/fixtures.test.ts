import { describe, expect, it } from "vitest";
import { PACKET_SCHEMA_VERSION, type Packet } from "../src/packet/types";
import { validatePacket } from "../src/packet/validate";
import deployRegressionSev1 from "../fixtures/packets/deploy-regression-sev1.json";
import invalidMissingSignals from "../fixtures/packets/invalid-missing-signals.json";
import noiseFlap from "../fixtures/packets/noise-flap.json";
import saturationSev0 from "../fixtures/packets/saturation-sev0.json";

/**
 * The committed packets every later test builds its scenario from.
 *
 * They are imported statically rather than read from disk because these tests
 * run inside workerd, where there is no filesystem to read from; the bundler
 * resolves each JSON file at build time and the committed file stays the single
 * copy, so a producer curling `fixtures/packets/*.json` and a test asserting
 * against it can never be looking at two different payloads.
 */
const FIXTURES = {
  "deploy-regression-sev1": deployRegressionSev1,
  "noise-flap": noiseFlap,
  "saturation-sev0": saturationSev0,
  "invalid-missing-signals": invalidMissingSignals,
} as const;

export type FixtureName = keyof typeof FIXTURES;

/**
 * Hand back a fixture as the unknown payload a producer would have posted.
 *
 * The clone is what keeps the fixtures shared: a static import is one object
 * for the whole test run, so a caller that mutated it would rewrite the inputs
 * of every other test in the file. The return type is deliberately `unknown`
 * rather than `Packet`, because a fixture earns the name packet by passing
 * `validatePacket`, and a test that skipped that step would be asserting against
 * a payload the Agent might refuse.
 */
export function loadFixture(name: FixtureName): unknown {
  return structuredClone(FIXTURES[name]);
}

/** The three ids later tests and the README refer to by name; renaming one breaks them. */
const VALID_FIXTURES: readonly [FixtureName, string][] = [
  ["deploy-regression-sev1", "fix-deploy-regression-001"],
  ["noise-flap", "fix-noise-flap-001"],
  ["saturation-sev0", "fix-saturation-sev0-001"],
];

function accepted(name: FixtureName): Packet {
  const result = validatePacket(loadFixture(name));
  if (!result.ok) throw new Error(`${name} failed validation: ${result.errors.join(" | ")}`);
  return result.packet;
}

describe("a valid fixture packet", () => {
  it.each(VALID_FIXTURES)("%s validates and keeps the identity it was written with", (name, id) => {
    const packet = accepted(name);

    expect(packet.packet_id).toBe(id);
    expect(packet.schema_version).toBe(PACKET_SCHEMA_VERSION);
    expect(packet.env).toBe("prod");
  });

  it("describes a deploy-shaped regression with the deploy still in the packet", () => {
    const packet = accepted("deploy-regression-sev1");

    expect(packet.service).toBe("checkout");
    expect(packet.signals.error_rate).toBeCloseTo(0.21);
    expect(packet.signals.error_rate_baseline).toBeCloseTo(0.004);
    expect(packet.signals.p95_latency_ms).toBe(1180);
    expect(packet.signals.p95_latency_baseline_ms).toBe(240);
    expect(packet.recent_deploy?.minutes_ago).toBe(7);
    expect(packet.alert_labels).toContain("http-5xx");
    // Two spans carry the errors and a third carries none: a summary that ranks
    // spans by traffic instead of by errors would pick the wrong two.
    expect(packet.top_spans.filter((span) => span.error_count > 1000)).toHaveLength(2);
  });

  it("describes a flapping alert whose signals never leave their baselines", () => {
    const packet = accepted("noise-flap");

    expect(packet.service).toBe("search");
    // Under a tenth over baseline on both axes, which is the whole point of the
    // fixture: the alert label is alarmist and the measurements are not.
    expect(packet.signals.error_rate).toBeLessThan(packet.signals.error_rate_baseline * 1.5);
    const latencyRatio = packet.signals.p95_latency_ms / packet.signals.p95_latency_baseline_ms;
    expect(latencyRatio).toBeLessThan(1.08);
    expect(packet.recent_deploy).toBeUndefined();
    expect(packet.alert_labels).toEqual(["sev2-flapping"]);
  });

  it("describes resource pressure with no deploy to blame it on", () => {
    const packet = accepted("saturation-sev0");

    expect(packet.service).toBe("payments");
    expect(packet.signals.slo_burn_rate).toBeCloseTo(14.2);
    expect(packet.signals.saturation?.cpu_pct).toBe(97);
    expect(packet.signals.saturation?.queue_depth).toBe(8400);
    expect(packet.recent_deploy).toBeUndefined();
  });

  it("is plain JSON an external producer can post verbatim", () => {
    for (const [name] of VALID_FIXTURES) {
      const payload = loadFixture(name);
      // A round trip through the wire format has to be a no-op, or the file on
      // disk is not the thing the tests have been asserting against.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
  });
});

describe("the invalid fixture packet", () => {
  it("is rejected for exactly the two defects it was written to carry", () => {
    const result = validatePacket(loadFixture("invalid-missing-signals"));

    if (result.ok) throw new Error("the invalid fixture was accepted");
    expect(result.code).toBe("invalid_packet");
    // Exactly two: a third defect would mean the fixture is proving something
    // other than the required-field and strict-unknown-key rules it exists for.
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContainEqual(expect.stringContaining("signals.p95_latency_baseline_ms"));
    expect(result.errors).toContainEqual(expect.stringContaining("raw_otlp"));
  });
});
