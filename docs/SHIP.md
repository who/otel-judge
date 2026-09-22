# Ship gate — AI-assisted coding disclosure

Runnable checklist for the Cloudflare application submission. Each step has an exact command. Do not treat prose-only steps as done.

**Locked disclosure source:** the Ortus harness — the standing prompts every worker was launched under, version-pinned — followed by bead issue text (the prompts that drove the work), both via `--from-beads`. Grind transcripts are optional and are **not** the ship artifact.

The optional `prompts/public/` directory from early PRD drafts is **declined**: one committed `PROMPT_HISTORY.md` is enough; a second tree would drift.

---

## Before you start

```bash
cd ~/code/otel-judge
git status
```

Raw Ortus grind logs stay local and gitignored:

```bash
git check-ignore -q logs
```

---

## 1. Refresh bead data (optional but recommended)

If new beads closed since the last disclosure:

```bash
bd dolt pull
```

Skip that command if you do not use a Dolt remote.

---

## 2. Generate the sanitized prompt history (ship path)

Full regenerate (overwrites `PROMPT_HISTORY.md`):

```bash
node scripts/prompt-history.mjs --from-beads
```

Dry-run (print only, no write):

```bash
node scripts/prompt-history.mjs --from-beads --dry-run | less
```

This opens the document with `## Ortus harness`: every standing prompt the installed Ortus resolves, quoted in full and pinned to the `ortus --version` and backend that ran them. Sections keyed by bead id follow, from sanitized title, description, design, and acceptance criteria. It does **not** read `logs/`.

The harness is read live from the installed Ortus, so `ortus` must be on `PATH`. If it is not, or if it exposes no prompts, the run fails with `Ortus harness unavailable: ...` and writes nothing — a disclosure that quietly lost half of itself is worse than one that did not generate.

### Working modes

- **Ship / submit:** always `--from-beads` (full replace of `PROMPT_HISTORY.md`).
- **Optional debug only:** `node scripts/prompt-history.mjs` (raw sanitized logs) or `--llm-compact` (Claude narration of logs). Do not commit those outputs as the disclosure unless you intentionally supersede the beads extract.

`--append` applies to the log-based generator only. Do not combine `--append` or `--llm-compact` with `--from-beads`.

---

## 3. Manual review (required — not automatable)

**This step must not be automated away.**

```bash
git diff -- PROMPT_HISTORY.md
```

If the file is new or you prefer a full read:

```bash
less PROMPT_HISTORY.md
```

Check for:

1. Business-sensitive narrative the pattern sanitizer cannot see (customer names, private URLs, credentials in prose).
2. Sections that should not ship (edit those bead fields with `bd`, then re-run step 2).
3. Accidental host or account leakage. Fix beads and re-run step 2 if needed.

If sensitive material cannot be removed without destroying disclosure value, stop, record a PLAN-GAP on the relevant bead, and **do not commit**.

---

## 4. Verify sanitizer and links before commit

```bash
node scripts/prompt-history.mjs --from-beads --dry-run >/dev/null
grep -q '^## Ortus harness' PROMPT_HISTORY.md
test -f PROMPT_HISTORY.md && test -f docs/SHIP.md
grep -q 'PROMPT_HISTORY.md' README.md
grep -q 'SHIP.md' README.md
git check-ignore -q logs
```

---

## 5. Commit the disclosure artifacts

```bash
git add PROMPT_HISTORY.md docs/SHIP.md README.md
git commit -m "Publish AI-assisted coding disclosure"
git push origin HEAD
```

---

## 6. Confirm README links resolve on the default branch

After push, open `PROMPT_HISTORY.md` and `docs/SHIP.md` on the default branch. Both must load (no 404).

---

## Submit (human only)

Submitting the Cloudflare application is out of scope for automation. Use this checklist's outputs as the disclosure packet when you submit.
