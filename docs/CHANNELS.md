# Channels

A **channel** is whatever carries a packet to the Agent: the signed HTTP door, an
OTLP collector, a browser board on the Agents SDK socket, a chat app, a replay
script. The Agent is the thing being reached. Nothing it holds may reach back.

This document is the procedure for swapping one channel for another, written as
a concrete diff so the claim can be checked rather than believed, and
`test/portability.test.ts` fails the build the moment the diff stops being true.

## The drop-into-Slack test

The requirement is stated in `prd/PRD.md`: deleting the OTLP adapter and adding
a Slack channel must change only door wiring, never the Agent class. Here is
exactly what that change touches.

**Deleted**

- `src/ingress/otlp.ts` — the OTLP/JSON translation and its `handleOtlpIngest`
  entry point.
- The `OTLP_INGEST_PATH` branch in `src/worker/router.ts`, four lines that route
  `POST /ingest/otlp` at that entry point.
- `test/otlp-adapter.test.ts` and `fixtures/otlp/`, which exist to prove the
  translation, not the Agent.
- The demo origin in the `DEMO_ORIGINS` var in `wrangler.jsonc`, once no browser
  channel reads the socket. `src/worker/cors.ts` keeps its default and needs no
  edit; an empty allowlist simply earns no origin an allow header.

**Added**

- `src/ingress/slack.ts` — Slack request-signature verification over the exact
  request bytes, a Slack event translated into a packet, and a `handleSlackEvent`
  entry point returning the acknowledgement Slack expects inside its three-second
  budget.
- One branch in `src/worker/router.ts` routing `POST /slack/events` at that entry
  point, in the same shape as the two ingress branches already there.
- `SLACK_SIGNING_SECRET` as a Wrangler secret, alongside `FIREHOSE_SECRET`.
- `test/slack-adapter.test.ts`, the counterpart of the OTLP adapter test.

**Untouched**

- `src/agent/OtelJudgeAgent.ts`, `src/agent/accept.ts`, `src/agent/persist.ts`,
  `src/agent/state.ts`, `src/agent/store.ts`, `src/agent/identity.ts`,
  `src/agent/api-types.ts`.
- `src/workflow/EvaluateWorkflow.ts`, `src/workflow/evaluate.ts`,
  `src/workflow/summarize.ts`.
- `src/packet/`, `src/jev/`, `src/llm/` — the contract and the two models are
  what the channel delivers into, not something a channel configures.

A new channel is therefore one module, one route, one secret, and one test. The
reason it stays that small is that a channel converts its own dialect into the
packet contract and then uses the same two surfaces every other channel uses:
signed ingress through `forwardToAgent` in `src/ingress/forward.ts`, or the SDK's
own `/agents/otel-judge-agent/:name` routes for sockets and callable methods.

## What a channel may not do

- **Reach into the store.** `src/agent/store.ts` is the Agent's private SQL. A
  channel that reads it has forked the history contract: two writers, no
  dedupe, and no `setState` broadcast to the clients watching.
- **Add a field to live state.** `JudgeState` in `src/agent/state.ts` is what
  every connected client receives. A field that only one channel understands
  makes the snapshot a per-channel shape, and the browser board starts having to
  know what Slack is.
- **Import from `src/agent/` at all**, with two exceptions: `identity.ts`, so the
  door can derive the same `<env>:<service>` name the Agent answers to, and
  `api-types.ts`, so a client can hold `HistoryRow` and `PacketDetail` without
  importing the Durable Object class.
- **Assume it is the only channel.** Packet ids are global and deduplicated; a
  channel that re-derives an id per delivery will resubmit work the Agent has
  already judged.

## The guard

`test/portability.test.ts` reads the source text of every module under
`src/agent/` and `src/workflow/` and fails on any import specifier that resolves
into `src/worker/` or `src/ingress/`, or that names `slack`, `pages`, or `demo`.
Static imports, type-only imports, side-effect imports, re-exports, and dynamic
`import()` calls all count; a type dependency couples the Agent to a channel's
shape just as surely as a value does. Comments and string literals do not count,
so prose may name a channel freely — this document's own vocabulary would
otherwise be unwritable in a source comment.

The list of scanned modules is maintained by hand in that test and compared
against what is actually on disk, so adding a module under either directory
fails the test until the list is updated and the new module has been scanned.

If the boundary ever has to move — a genuinely shared module that both the door
and the Agent need — move the module to a neutral directory instead of adding an
exception to the guard. The boundary is an acceptance criterion of the PRD, and
the first exception is what makes the second one easy. If no neutral home
exists, that is a design question, not a test configuration change.

Relaxing the scan and leaving this document unchanged is itself the bug: the
document and the test are two statements of one contract, and they are edited
together or not at all.
