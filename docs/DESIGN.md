# OTel Judge — Design decisions (historical)

**Status:** Historical artifact — **not** the bead-decomposition source of truth.  
**Date:** 2026-09-22  
**Context:** Architecture workshop for the Cloudflare Agents optional assignment (assistant-aided).

Build from each repo’s `prd/PRD.md` (this file is history only).

| Repo | PRD path | Role |
|---|---|---|
| `who/otel-judge` | [`prd/PRD.md`](../prd/PRD.md) | **Submit** — Agent + Worker + Workflow |
| `who/otel-judge-demo` | `prd/PRD.md` | GitHub Pages board |
| `who/otel-judge-firehose` | `prd/PRD.md` | Packet producer (fixtures + chaos) |

## What we decided (summary)

Recorded here so the decision path stays auditable. Normative requirements live in the PRDs.

1. **Product:** Consume-only Agent evaluates OTel-derived **packets** with Jev (System One) → Workers AI Llama (System Two); SQL history + live state.  
2. **No generation in the Agent;** producers are separate channels.  
3. **Ownership:** portable Agent vs Worker door vs swappable channels (Pages, OTLP/webhook, Slack later).  
4. **Repos (three):** submit `who/otel-judge`; demo `who/otel-judge-demo`; producer `who/otel-judge-firehose`.  
5. **UI:** light-mode product demo on GitHub Pages; not Factorio-branded; not HN chrome.  
6. **Prompt history:** raw Ortus logs gitignored; PRD ship gate publishes sanitized `PROMPT_HISTORY.md`.  
7. **CF docs fit:** webhook/telemetry Agent + AgentWorkflow evaluate pipeline; Worker/Agent are sibling runtimes.  
8. **Diamond lock (revised 2026-09-22):** full Jev distributions to Llama as the priors its verdict is grounded in; Llama waits for a successful Jev and is not asked at all when System One never answered; a departure from a noise-leaning prior must set `disagrees_with_prior` and cite the summary; a verdict that grades an incident over noise-majority priors (≥ 0.7) without setting that flag is deferred down to `noise` after the fact; no hard confidence / needs_human gates. The earlier lock let a Jev failure log-and-continue into Llama, which produced a flag on a packet System One had called noise.

---

## Why DESIGN is not decomposed

Ortus beads should track **PRD** requirements and acceptance criteria. This file stays a **decision history** so we do not lose “why,” without forcing implementers to dig design narrative for “what to build.”

When PRDs and DESIGN disagree, **PRD wins** after an explicit update; then note the change here in a dated changelog line.

## Changelog

- 2026-09-22 — Initial lock from architecture workshop; PRDs made normative for beads.
- 2026-09-22 — Three PRDs locked: otel-judge, otel-judge-demo, otel-judge-firehose (producer elevated from optional stub).
- 2026-09-22 — Soft prior deference: System Two's severity defers to a noise-majority prior unless it declares `disagrees_with_prior`.
