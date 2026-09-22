# OTel Judge

A Cloudflare Agent that judges OpenTelemetry incidents. A producer posts a
normalized **packet** — one service, one time window, already aggregated — and a
durable Agent evaluates it through a two-model pipeline: TypeSafe **Jev** answers
a fixed set of narrow questions as System One, and Workers AI **Llama** reads
those full probability distributions and writes the verdict as System Two.

The Agent is consume-only. It never generates telemetry, never fabricates a
distribution when System One is unreachable, and never imports anything from a
channel — the browser board, a future Slack app, and a replay script all reach
the same surface.

A live demo board is maintained in a separate repository and linked at the
bottom of this file; no demo source is in this repository.

## Cloudflare assignment mapping

| CF requirement | Implementation in this repo |
|---|---|
| LLM | Workers AI Llama as judge; TypeSafe **Jev** as external System One |
| Workflow / coordination | `AgentWorkflow`: summarize → Jev → Llama; retries; `mergeAgentState` |
| User input / interactive surface | Channel-agnostic Agent API; Pages is a separate channel repo |
| Memory / state | `setState` (live) + `this.sql` (history, labels) |
| Prompt history | Sanitized Ortus trail at ship; raw logs gitignored |

## Architecture

The Worker door and the Agent are **sibling runtimes colocated in one Wrangler
project** — the Agent is not nested inside the Worker. `src/index.ts` exports the
Worker's `fetch` handler alongside the `OtelJudgeAgent` and `EvaluateWorkflow`
classes the runtime binds; each is entered directly by the platform.

```
producer ──POST /ingest (HMAC-signed)──▶ Worker door  (src/worker/router.ts)
                                          verify → bound → derive identity
                                          ▼
                                        Agent  (src/agent/OtelJudgeAgent.ts)
                                          dedupe → store → setState(accepted) → 202
                                          ▼
                                        Workflow  (src/workflow/EvaluateWorkflow.ts)
                                          summarize → Jev → Llama
                                          mergeAgentState at each milestone
                                          ▼
                                        Agent  onWorkflowComplete
                                          persist to SQL → setState(complete)
                                          ▼
                                        clients watching the WebSocket
```

The door owns transport concerns only: CORS, health, signature verification, a
128 KiB body cap, then `routeAgentRequest`. Evaluation logic lives in
`src/workflow/evaluate.ts`, which takes its steps as arguments, so the pipeline
is testable without a workflow engine behind it.

One Agent instance exists per service per environment, named `<env>:<service>`
by `src/agent/identity.ts` — the door and the Agent share that one derivation so
a packet can never be routed to an instance nothing addresses again.

The live snapshot every connected client sees (`src/agent/state.ts`) carries the
stage — `idle`, `accepted`, `summarized`, `jev`, `judging`, `complete`,
`failed` — plus the packet count, the last packet id, the last verdict severity
and summary, and whether Jev answered. Distributions, prompts, and verdict prose
stay in SQL and are fetched deliberately.

## Packet contract

Schema version 1, defined in `src/packet/types.ts` and enforced by
`src/packet/validate.ts`. Required: `packet_id`, `service`, `env`
(`prod` | `staging` | `dev`), `window` (UTC, both ends), `signals` (error rate
and baseline, p95 latency and baseline, request rate, SLO burn rate, optional
saturation), `top_spans`, `exemplar_trace_ids`, `alert_labels`. Optional:
`recent_deploy`, `log_snippets`. Every array is capped, unknown keys are
rejected, and an invalid packet comes back with the whole error list rather than
the first failure.

Worked example: `fixtures/packets/deploy-regression-sev1.json`. Other fixtures
cover a saturation sev0, a noise flap, and an invalid packet.

## Diamond model

System One is `POST https://api.typesafe.ai/v1/systemone`, called with plain
`fetch` and authorized by the `TYPESAFE_API_KEY` secret. All five questions go in
one batch, in a fixed order, and the **full probability vector plus noul mass**
for each is what reaches the judge and what is stored — never an argmax.

| Key | Type | Answers |
|---|---|---|
| `severity` | choice | sev0 / sev1 / sev2 / noise |
| `needs_human` | noul | Would an SRE want eyes on this now? |
| `deploy_related` | noul | Is this related to a recent deploy? |
| `noise_likely` | noul | Is this most likely noise? |
| `root_cause_family` | choice | deploy_regression / dependency / saturation / bad_config / unknown |

There are **no hard gates**: confidence and `needs_human` are advisory inputs to
the judge, never a branch that stops the pipeline. System Two is always called —
when Jev is unreachable or unconfigured, the run is recorded as degraded with a
reason token and the judge is asked anyway with the state it has. Jev never
writes prose; Llama owns the narrative.

The judge model is pinned in `src/llm/models.ts` to
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, overridable with the `LLAMA_MODEL`
var. The System One model defaults to `jev-latest`, overridable with `JEV_MODEL`.

## API

**Worker door**

| Route | Purpose |
|---|---|
| `GET /health` | Readiness and which bindings are present; wakes no Agent |
| `POST /ingest` | A normalized packet, signed with `x-firehose-signature` |
| `POST /ingest/otlp` | The OTLP/JSON dialect of the same door, translated to a packet |
| `/agents/otel-judge-agent/:name` | The Agents SDK surface: packet POST, WebSocket, callable RPC |

Ingress requires an HMAC-SHA256 of the exact request body under `FIREHOSE_SECRET`
as a lowercase hex digest. A deployment with no secret answers `503` rather than
accepting unsigned packets; a bad digest answers `401`. A fresh packet is
acknowledged `202` with `{ accepted, duplicate, packet_id, agent, stage }` before
the evaluation runs; a packet id already stored answers `200` with
`duplicate: true` and the status the first copy reached.

**Callable Agent methods** (over the SDK's RPC channel, for any client)

| Method | Arguments | Returns |
|---|---|---|
| `getHistory` | `limit` (default 20, clamped to 1–100) | `HistoryRow[]` — id, service, env, window, received time, status, verdict severity |
| `getPacket` | `packetId` | `PacketDetail` with the packet, the Jev run, every answer's full distribution, the verdict, and human labels — or `null` |
| `labelPacket` | `packetId`, `label`, optional `note` | The written `HumanLabel` |

Labels are `sev0`, `sev1`, `sev2`, `noise`, or `wrong`, with a note of at most
500 characters. Labelling overwrites no verdict and re-runs nothing: the human
opinion sits beside the model's, which is what makes `wrong` worth recording.
The contract types live in `src/agent/api-types.ts` so a channel can import them
without importing the Durable Object class.

## Configuration

Secrets, set through Wrangler and never present in client-reachable config:

```
npx wrangler secret put TYPESAFE_API_KEY   # System One bearer token
npx wrangler secret put FIREHOSE_SECRET    # shared HMAC secret for /ingest
```

Plain vars in `wrangler.jsonc`, safe to read and to edit:

| Var | Default | Meaning |
|---|---|---|
| `LLAMA_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI judge model |
| `JEV_MODEL` | `jev-latest` | System One model |
| `DEMO_ORIGINS` | `https://who.github.io` | Comma-separated CORS allowlist for browser channels |

Bindings: `AI` (Workers AI), `OTEL_JUDGE_AGENT` (Durable Object, SQLite),
`EVALUATE_WORKFLOW` (Workflows).

## Local development

```
npm ci
npx wrangler types                  # generate binding types (gitignored)
npx wrangler dev                    # http://localhost:8787
npx vitest run                      # the whole suite, on the Workers pool
npm run typecheck                   # regenerate types, then tsc --noEmit
```

For local secrets, put `TYPESAFE_API_KEY` and `FIREHOSE_SECRET` in a `.dev.vars`
file; it is gitignored. Without a Jev key the pipeline still runs and records the
run as degraded, so the door and the judge can be exercised offline.

## Deploy

```
npx wrangler deploy --dry-run --outdir dist   # build without deploying
npx wrangler deploy
curl https://<your-worker>.workers.dev/health
```

Re-run `npx wrangler types` after changing `wrangler.jsonc`.

## What this repository does not own

- The demo board UI — it lives in `otel-judge-demo` and is linked below.
- The packet producer and chaos generator — a separate repository.
- A Slack adapter. The drop-into-Slack test is the design constraint: deleting
  the OTLP adapter and adding a Slack channel must change only door wiring, never
  the Agent class. Nothing under `src/agent/` imports a channel, and
  `test/portability.test.ts` fails the build if anything ever does.
  [`docs/CHANNELS.md`](docs/CHANNELS.md) writes that swap out as a concrete
  add-and-delete file list, and states what a channel may not do.
- TypeSafe and Workers AI as products; this is an integration against both.

## Links

- **Live demo (separate repository):** [who/otel-judge-demo](https://github.com/who/otel-judge-demo),
  published at <https://who.github.io/otel-judge-demo/>. It is maintained on its
  own lifecycle and may lag this repository.
- **Requirements:** [`prd/PRD.md`](prd/PRD.md) — normative.
- **Channel procedure:** [`docs/CHANNELS.md`](docs/CHANNELS.md) — how a channel
  is swapped, and the import boundary that keeps the Agent out of it.
- **Decision history:** [`docs/DESIGN.md`](docs/DESIGN.md) — why, not what. Where
  the two disagree, the PRD wins.
