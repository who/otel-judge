# PRD — who/otel-judge

**Status:** Draft for beads decomposition (source of truth for build)  
**Repo (submit to Cloudflare):** `who/otel-judge`  
**Depends on:** TypeSafe Jev account/key; Cloudflare Workers + Workers AI  
**Does not include:** GitHub Pages UI (see `PRD-otel-judge-demo`)  
**Historical decisions log:** `docs/DESIGN.md` (not decomposed into beads)

---

## Problem

Cloudflare’s optional Agents assignment asks for a GitHub repo showing an AI app with LLM, durable coordination, interactive input, and memory. We need a **portable Cloudflare Agent** that evaluates OpenTelemetry-derived **packets** using Jev + Llama — suitable to submit as the application URL, with a separate live demo linked from the README.

## Goals

1. Ship a public Agent + Worker project reviewers can clone, skim in &lt;5 minutes of README, and optionally run.
2. Agent is **consume-only**: classify/evaluate firehose packets; never invent telemetry.
3. Prove Cloudflare Agents fit: Durable Object Agent, AgentWorkflow, SQL memory, live state, external tool (Jev), Workers AI judge.
4. Keep channels swappable (Pages demo / Slack later) without rewriting Agent core.
5. Satisfy AI-assisted coding disclosure via **sanitized** prompt history at ship.

## Non-goals

- Hosting the demo UI in this repo
- Chaos packet generation inside the Agent class
- Hard confidence / `needs_human` gates
- Full observability product (SLO dashboards, paging vendors) beyond evaluate + memory + state
- Nesting Agent “inside” Worker as a mental model (they are sibling runtimes)

## Users

- **Primary:** Cloudflare application reviewer (GitHub URL + README + demo link)
- **Secondary:** Maintainer — Ortus/beads implementation; later Slack channel consumers

## Vocabulary (normative)

| Term | Meaning |
|---|---|
| **Packet** | Unit of evaluation (not “episode”). Normalized telemetry window/payload the Agent accepts. |
| **Producer / firehose** | Emits packets into an ingest channel (fixtures, chaos generator, real OTLP collectors). |
| **Channel** | Adapter that reaches the Agent (OTLP/webhook, GitHub Pages, Slack later). |
| **Worker door** | HTTP/WebSocket edge: routing, secrets, verification, limits — not evaluate logic. |
| **Agent** | Portable durable identity: accept → evaluate → remember → expose state. |

## Cloudflare assignment mapping (normative)

| CF requirement | Implementation in this repo |
|---|---|
| LLM | Workers AI Llama as judge; TypeSafe **Jev** as external System One |
| Workflow / coordination | `AgentWorkflow`: summarize → Jev → Llama; retries; `mergeAgentState` |
| User input / interactive surface | Channel-agnostic Agent API; Pages is a separate channel repo |
| Memory / state | `setState` (live) + `this.sql` (history, labels) |
| Prompt history | Sanitized Ortus trail at ship; raw logs gitignored |

## Ownership (normative)

### This repo owns

**Worker door**

- `fetch` router: health, firehose ingress hooks, `routeAgentRequest`
- `getAgentByName` identity routing
- Secrets: `TYPESAFE_API_KEY`; bindings: `AI`, Agent DO, optional rate-limit KV
- Shared body-size / quota limits; CORS allowlist for known demo origin(s)

**Portable Agent**

- Packet-in JSON contract; validation; dedupe by packet id
- Live `setState` snapshot for any connected client
- SQLite: packets, Jev answers (full distributions), Llama verdicts, human labels, timestamps
- `runWorkflow(Evaluate)` per accepted packet; completion handling
- Channel-agnostic evaluate loop (no Pages/Slack imports)

**AgentWorkflow — Evaluate** (started by Agent, not by Pages)

1. **Summarize (TS):** build compact packet `state` for Jev; compute deltas/baselines in code; never dump raw OTLP trees to Jev  
2. **Jev System One:** batch questions; return full probability vectors  
3. **Llama System Two:** judge using vectors as priors; critique + next action  
4. **Progress:** `mergeAgentState` at milestones; SQL persist on completion  

### This repo does not own

- GitHub Pages board / Vite UI  
- Chaos generator product (see `PRD-otel-judge-firehose`)  
- Slack adapter (future)  
- TypeSafe / Workers AI as products (integrations only)

### Drop-into-Slack test (acceptance mindset)

Deleting Pages + OTLP-specific adapter code and adding a Slack channel adapter must **not** require rewriting the Agent class — only Worker door channel wiring.

## Diamond model — Jev + Llama (normative)

- **System One (Jev):** `POST https://api.typesafe.ai/v1/systemone`  
  - Auth: Worker secret `TYPESAFE_API_KEY` (Bearer)  
  - Transport: plain `fetch` (no Node SDK on Workers)  
  - Model: `jev-latest` while exploring; pin `jev-1.13.0` once questions stabilize  
  - Input: compact packet JSON as `state`  
  - Batch atomic questions in one request (answers independent)  
  - No streaming  
- Hand **full distributions** (+ `noul`) to Llama — not argmax-only  
- **No hard gates** on confidence or `needs_human`; confidence is advisory  
- Always call System Two after Jev (or log-and-continue on Jev failure, still attempt judge with available state)  
- Jev does not write prose; Llama owns narrative  

### Questions map (MVP)

| Key | Type | Criteria / notes |
|---|---|---|
| `severity` | choice | sev0 / sev1 / sev2 / noise |
| `needs_human` | noul | Would an SRE want eyes now? |
| `deploy_related` | noul | |
| `noise_likely` | noul | |
| `root_cause_family` | choice | deploy_regression / dependency / saturation / bad_config / unknown |

## Runtime flow (normative)

```
Producer → firehose channel (Worker ingress)
        → verify + derive identity
        → getAgentByName(...) → Agent.onRequest
Agent   dedupe + accept + runWorkflow(Evaluate) → fast ack (e.g. 202)
Workflow summarize → Jev → Llama
        mergeAgentState at milestones
Agent   onWorkflowComplete → SQL + final setState
Clients observe via useAgent / future Slack adapter
```

Evaluate must not be a single giant synchronous `onRequest` body; use AgentWorkflow for durable steps/retries (CF Agents + Workflows guidance).

## Packet contract (MVP intent)

Agent accepts a **normalized packet** (exact schema = beads). Intentional fields include:

- `packet_id`, `service`, `env`, `window`
- `signals` (error rate, latency vs baseline, SLO burn, etc.)
- `top_spans`, `exemplar_trace_ids`, `recent_deploy`, `alert_labels`, optional `log_snippets`

Worker firehose adapter may translate OTLP → this contract; Agent only sees the contract.

## Requirements

### Functional

- FR1: Accept normalized packet JSON; reject oversize/invalid with clear errors  
- FR2: Start durable Evaluate Workflow; retry Jev/Llama steps safely  
- FR3: Persist full Jev distributions + Llama verdict in SQL  
- FR4: Broadcast stage/progress via Agent `setState` to WebSocket clients  
- FR5: README links live demo without embedding demo source  
- FR6: Implement diamond model + questions map above  
- FR7: Consume-only — no packet generation in Agent class  

### Non-functional

- NFR1: No secrets in client-reachable config  
- NFR2: Public-repo-safe sanitized prompt history  
- NFR3: Agent class has zero imports from demo app  
- NFR4: Worker and Agent are colocated in one Wrangler project, sibling runtimes  

## Acceptance criteria

- [ ] Deployed Worker evaluates a fixture packet end-to-end (Jev + Llama)  
- [ ] Connected client sees state updates during Workflow  
- [ ] SQL retains history (query via `@callable` or documented API)  
- [ ] README points to `otel-judge-demo` Pages URL  
- [ ] `PROMPT_HISTORY.md` published (sanitized) before application-ready  
- [ ] Slack drop-in test documented: Agent API unchanged if Pages removed  
- [ ] Questions map + no-hard-gates behavior covered by tests or documented fixtures  

## Ship gate — prompt history

Before application submit:

1. Gather Ortus logs for this repo’s beads (local, **gitignored**).  
2. Sanitize (repo-relative paths; strip secrets/hosts).  
3. Commit `PROMPT_HISTORY.md` (+ optional `prompts/public/`).  
4. Link sections to bead/PR ids.  
5. Prefer per-milestone append + final ship pass.

## Beads decomposition (epics)

1. **Scaffold** — Wrangler, Agent class, DO binding, routing, health  
2. **Packet contract** — schema, validation, dedupe, SQL DDL  
3. **Jev client** — systemone fetch, questions map, error/backoff  
4. **Evaluate Workflow** — summarize, Jev, Llama judge, `mergeAgentState`, completion  
5. **Firehose ingress** — Worker webhook/OTLP→packet adapter (not Agent core)  
6. **Docs** — README, demo link placeholder, pointer to historical DESIGN  
7. **Ship compliance** — PROMPT_HISTORY publish checklist/script  

## Open questions

- Pin Workers AI model id at implement time (assignment mentioned Llama 3.3).  
- Single `demo` Agent instance vs per-service names for MVP.  
- Degraded mode when TypeSafe key missing (fixture judge path?).  
