/**
 * The seven stages a judged packet moves through, in the order it moves.
 *
 * `failed` is terminal like `complete`: a run that fails has still finished, so
 * a client watching the stage never has to guess whether more is coming.
 */
export type Stage =
  | "idle"
  | "accepted"
  | "summarized"
  | "jev"
  | "judging"
  | "complete"
  | "failed";

/**
 * The live snapshot every connected client sees.
 *
 * `setState` broadcasts to every protocol-enabled WebSocket connection and the
 * browser channel is served to a public origin, so this shape is deliberately
 * small and free of anything sensitive: Jev distributions, the prompts sent to
 * the model, and verdict prose stay in SQL and are fetched deliberately. Every
 * field is JSON-safe because the runtime serializes the whole object on its way
 * to each client.
 */
export interface JudgeState {
  agent_name: string;
  stage: Stage;
  packets_seen: number;
  last_packet_id: string | null;
  last_verdict: { severity: string; summary: string } | null;
  jev_status: "ok" | "unavailable" | null;
  updated_at: string;
}

/**
 * What an Agent publishes before it has seen anything.
 *
 * `agent_name` is blank rather than guessed: a Durable Object is constructed
 * before it is told which name it answers to, so the accept path fills this in
 * once a packet names it. `updated_at` is the epoch rather than a construction
 * timestamp so that every cold Agent publishes an identical snapshot and a
 * client can tell "never updated" apart from "updated the moment you looked".
 */
export const INITIAL_STATE: JudgeState = {
  agent_name: "",
  stage: "idle",
  packets_seen: 0,
  last_packet_id: null,
  last_verdict: null,
  jev_status: null,
  updated_at: "1970-01-01T00:00:00.000Z",
};
