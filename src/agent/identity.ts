/** Each half of an Agent name is capped so the whole name stays short enough to read in a log line. */
const MAX_SLUG_LENGTH = 48;

/** Hex digits of the collision suffix appended when a value had to be cut. */
const FINGERPRINT_LENGTH = 8;

/** Stand-in for a value that normalises away to nothing, so no Agent is ever nameless. */
const UNKNOWN = "unknown";

/** The name a single shared Agent answers to; documentation and the browser channel use it. */
export const DEFAULT_AGENT_NAME = "demo";

/** The two packet fields identity depends on. The packet contract owns the rest of the shape. */
export interface PacketIdentity {
  env: string;
  service: string;
}

/**
 * FNV-1a over the full value, so two names that differ only past the cut still
 * land on different Agents. Hand-rolled because this digest is a durable
 * identity input: a dependency that changed its output by one bit would strand
 * every stored packet under a name nothing resolves to again.
 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(FINGERPRINT_LENGTH, "0");
}

/**
 * Normalise one identity component to lowercase `[a-z0-9-]`.
 *
 * Producers send service and environment names that were never meant to be
 * keys: mixed case, spaces, dots, emoji, a stray newline. All of it collapses
 * to dashes here so the same service always reaches the same Agent no matter
 * which producer spelled it.
 */
export function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (normalized.length === 0) return UNKNOWN;
  if (normalized.length <= MAX_SLUG_LENGTH) return normalized;

  const head = normalized
    .slice(0, MAX_SLUG_LENGTH - FINGERPRINT_LENGTH - 1)
    .replace(/-$/, "");
  return `${head}-${fingerprint(normalized)}`;
}

/**
 * Map a packet to exactly one durable Agent.
 *
 * One Agent per service per environment: SQL history and the live snapshot
 * belong to a single service, and interleaving two services in one instance
 * would make both unreadable. The output is a durable identity key — changing
 * this rule after packets exist strands their history under a name that is
 * never addressed again, so it is frozen once anything has been stored.
 */
export function agentNameForPacket(packet: PacketIdentity): string {
  return `${slug(packet.env)}:${slug(packet.service)}`;
}
