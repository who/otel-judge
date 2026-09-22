# Prompt history

Generated: 2026-09-22T14:57:22.424Z

Source: beads — the issue text that prompted each unit of work (title, description, design, acceptance). Not a grind transcript.

## otel-judge-4i3

**Epic: Ship compliance — sanitized prompt history** (epic, open)

### Description

> Satisfy the AI-assisted coding disclosure gate (PRD goal 5, NFR2, Ship gate section). Covers the sanitizer that turns local gitignored Ortus logs into a public-repo-safe transcript and the ship checklist that binds sections to bead and PR ids. Outcome: PROMPT_HISTORY.md can be published before application submit without leaking secrets or absolute paths.

## otel-judge-4i3.1

**Build the sanitizing prompt-history generator script** (task, closed)

### Description

> ## Objective
> Build the script that turns local gitignored Ortus run logs into a sanitized, public-repo-safe prompt history grouped by bead id.
> 
> ## Behavioral context
> Before: the AI-assisted coding disclosure would have to be assembled by hand from raw logs that contain absolute paths and possibly secrets. After: one command reads the local logs, redacts secret-shaped material and rewrites absolute paths to repository-relative ones, groups entries under their bead ids, and writes a Markdown document that is safe to commit — refusing to write at all if a redaction rule cannot be applied.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The Node script, its redaction rules, its bead grouping, its command-line interface, and bounded unit tests for the sanitizer.
> 
> ## Non-goals
> No commit of the generated document, which the ship checklist task owns. No log collection from other machines and no changes to what Ortus writes. No automatic redaction of business content beyond the documented secret shapes.
> 
> ## Concrete locations
> Create `scripts/prompt-history.mjs` (exports and uses `main()`, `sanitize(text, repoRoot)`, `collectLogEntries(dir)`, `groupByBead(entries)`, `renderMarkdown(groups)`) and `test/prompt-history.test.ts`. Reads `logs/` and writes `PROMPT_HISTORY.md`. Edits `.gitignore` if needed. Evidence: CodeGraph index is empty (greenfield repo); `logs/plan-20260921-191817.log` already exists and `logs/` is already gitignored by the ortus block.
> 
> ## Resolved decisions
> - The script is plain Node ESM run with `node scripts/prompt-history.mjs`, not a Worker or a TypeScript module. It runs on a developer machine with filesystem access, which the Workers runtime does not have, and keeping it dependency-free means it cannot drift with the Worker bundle.
> - Command-line interface: `--out <path>` defaults to `PROMPT_HISTORY.md`, `--logs <dir>` defaults to `logs/`, `--append` merges into an existing output instead of replacing it, `--dry-run` prints the rendered document to stdout without writing, and `--help` prints usage. The PRD prefers per-milestone append with a final full pass, which is why append is a first-class mode.
> - Redaction rules, applied in order: rewrite any absolute path containing the repository root to a repository-relative path; replace any value following a key matching `api[_-]?key`, `token`, `secret`, or `authorization` with `[redacted]`; replace Bearer [redacted]; replace runs of 32 or more hex or base64url characters; replace `*.workers.dev` hostnames with `[redacted-host]`; replace email addresses with `[redacted-email]`.
> - The script fails loudly rather than writing a partially sanitized document: if any line still matches a secret-shaped pattern after sanitization, it exits non-zero naming the log file and line number and writes nothing. A prompt history that leaks is worse than one that is late.
> - Entries are grouped by bead id parsed from the log text, matching the workspace issue prefix pattern generically rather than a hardcoded prefix, so the script keeps working if the prefix changes. Entries with no bead id are grouped under an `unattributed` heading rather than dropped.
> - The rendered document carries a generation timestamp, the bead id as a heading per group, and the sanitized entries in chronological order.
> - `logs/` stays gitignored and only the generated output is committed, matching the PRD gate.
> 
> ## Compatibility constraints
> Runs on Node 20 or later on Linux and macOS with no npm dependencies, so a reviewer can run it from a fresh clone. The output is committed to a public repository, so the redaction rules are a security control rather than a formatting preference. The bead id pattern must stay prefix-agnostic because the workspace prefix is configurable.
> 
> ## Ordered steps
> 1. Write the argument parser and `--help` output.
> 2. Implement `collectLogEntries` reading every file under the logs directory in name order and splitting it into timestamped entries.
> 3. Implement `sanitize` with the six documented rules in the documented order.
> 4. Implement the post-sanitization verification pass that exits non-zero on any remaining secret-shaped match.
> 5. Implement `groupByBead` with the prefix-agnostic id pattern and the unattributed fallback.
> 6. Implement `renderMarkdown` and the write, append, and dry-run modes.
> 7. Write `test/prompt-history.test.ts` exercising `sanitize` against a fixture string containing an absolute path, a Bearer [redacted], an api key assignment, a long hex run, a workers.dev hostname, and an email address.
> 8. Add a test that the verification pass rejects a string engineered to survive a naive rule.
> 9. Add a test that bead grouping works for two different prefixes and that unattributed entries survive.
> 10. Run the prompt-history test file and the script help output.
> 
> ## Dependencies
> Depends on the scaffold task only for the repository having a package.json to declare the script; the sanitizer itself has no code dependencies. Consumers: the ship checklist task runs this script and commits its output, and the README links the generated document.
> 
> ## Edge cases
> - An empty logs directory must produce a valid document with a stated absence rather than an error or an empty file.
> - A log line containing a repository-relative path that merely looks absolute must not be mangled.
> - Append mode must not duplicate a group that already exists in the output; it merges entries under the existing heading.
> - A log file with invalid UTF-8 bytes must be reported rather than silently producing mojibake in a public document.
> - A very large log directory must stream rather than loading every file into memory at once.
> - The verification pass must not itself print the secret it found; it prints the location only.
> 
> ## Plan-gap guidance
> If the Ortus log format does not carry bead ids in a parseable form, stop, record `PLAN-GAP` naming the observed format and a sample line, keep the sanitizer and its tests in place since they are format-independent, and route to planning. Do not attribute entries to beads by guessing from timestamps: the PRD gate requires sections linked to bead and PR ids, and a wrong attribution in a submitted artifact is worse than an unattributed section.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The sanitizer redacts Bearer [redacted], api-key assignments, long hex or base64 runs, workers.dev hostnames, and email addresses, and rewrites absolute repository paths to relative ones.
> - AC-2 (proves-new): The verification pass exits non-zero and writes nothing when a secret-shaped string survives sanitization.
> - AC-3 (proves-new): Entries group under bead headings for any workspace prefix, and entries with no bead id land under the unattributed heading rather than being dropped.
> - AC-4 (proves-new): The script runs from a fresh clone with no npm dependencies and prints its usage.
> - AC-5 (guards-existing): Raw logs remain gitignored and untracked.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/prompt-history.test.ts -t sanitize`
> - AC-2: `npx vitest run test/prompt-history.test.ts -t refuses`
> - AC-3: `npx vitest run test/prompt-history.test.ts -t grouping`
> - AC-4: `node scripts/prompt-history.mjs --help`
> - AC-5: `git check-ignore -q logs`
> 
> ## Targeted tests
> `npx vitest run test/prompt-history.test.ts`

## otel-judge-4i3.2

**Publish the ship-gate checklist and the sanitized prompt history** (task, open)

### Description

> ## Objective
> Publish the ship-gate checklist and the generated prompt history, so the disclosure requirement is a runnable procedure rather than a remembered intention.
> 
> ## Behavioral context
> Before: the PRD describes a five-step ship gate in prose and nothing in the repository executes or records it. After: a checklist document carries the exact command for each step, the generated prompt history is committed with its sections linked to bead ids, and the README points a reviewer at both.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The ship checklist document, the first committed generation of the prompt history, and the README links that make both discoverable.
> 
> ## Non-goals
> No changes to the sanitizer itself. No CI enforcement of the gate and no release automation. No submission of the application, which is a human action.
> 
> ## Concrete locations
> Create `docs/SHIP.md` and the generated `PROMPT_HISTORY.md`. Edit `README.md` to link both. Runs `scripts/prompt-history.mjs` from the sanitizer task. Evidence: CodeGraph index is empty (greenfield repo); the PRD ship-gate section at `prd/PRD.md` is the source of the five steps.
> 
> ## Resolved decisions
> - `docs/SHIP.md` is a numbered checklist mirroring the PRD gate, and each step carries its exact command: gather logs, generate the sanitized document, review the diff before committing, commit the document, and verify the README links resolve. A checklist whose steps are prose is a checklist nobody can run.
> - Per-milestone append is the default working mode and the final full pass before submit is a separate explicit step, matching the PRD preference. The document says which to use when.
> - Sections in the generated document are linked to bead ids by the generator; `docs/SHIP.md` states that a section with no bead id must be attributed by hand before submit rather than shipped unattributed, so the generator fallback does not become the resting state.
> - The optional `prompts/public/` directory from the PRD is not created. A single generated document is enough for the disclosure and a second location would drift; the checklist notes the option was considered and declined.
> - The review step is explicitly manual and explicitly before the commit: a human reads the generated diff for business-sensitive content the pattern-based sanitizer cannot recognise. The checklist says this is the step that must not be automated away.
> - The README gains a short disclosure section linking `PROMPT_HISTORY.md` and `docs/SHIP.md`, because a reviewer looking for the AI-assistance disclosure should find it from the front page.
> 
> ## Compatibility constraints
> `PROMPT_HISTORY.md` is committed to a public repository and is part of the submitted artifact, so its content is subject to the same secret-safety bar as any source file. The checklist references the sanitizer command-line interface, so a flag rename in that script requires editing this document in the same change. Raw logs stay gitignored.
> 
> ## Ordered steps
> 1. Write `docs/SHIP.md` as a numbered checklist with one exact command per step.
> 2. State the append-versus-full-pass rule and when each applies.
> 3. State the manual review step explicitly and mark it as not automatable.
> 4. Note the declined `prompts/public/` option and the reason.
> 5. Generate `PROMPT_HISTORY.md` from the current logs with the sanitizer.
> 6. Review the generated content by hand for business-sensitive material and for any unattributed section.
> 7. Add the disclosure section to the README linking both documents.
> 8. Verify the generated document contains no secret-shaped strings and that both README links resolve.
> 
> ## Dependencies
> Depends on the sanitizer task for the script and on the README task for the document to link from. Consumers: the human performing the submission follows this checklist, and the Cloudflare reviewer reads the disclosure it produces.
> 
> ## Edge cases
> - A generated document containing an unattributed section must be caught at the review step, not shipped.
> - Regenerating over an existing committed document must not lose hand-made attributions; append mode merges rather than replacing, and the checklist warns about the full-pass mode overwriting them.
> - A README link to a document that has not been generated yet is a dead link in the submitted artifact; verify both links resolve.
> - The checklist must stay accurate if the sanitizer flags change; the compatibility note above makes that coupling explicit.
> 
> ## Plan-gap guidance
> If the generated prompt history contains business-sensitive material that the pattern-based sanitizer cannot recognise and that cannot be removed without losing the disclosure value, stop, record `PLAN-GAP` naming the category of material and an example location, do not commit the generated document, and route to human handling. This is deliberately a human decision: judging what is sensitive in narrative content is not a rule the sanitizer can be taught in this task.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The ship checklist exists as numbered steps, each carrying the exact command that performs it.
> - AC-2 (proves-new): The generated prompt history is committed and contains no secret-shaped strings, verified by re-running the generator verification over it.
> - AC-3 (proves-new): The README links both the prompt history and the ship checklist, and both links resolve to files that exist.
> - AC-4 (guards-existing): Raw logs remain gitignored and untracked after the generation step.
> 
> ## Criterion checks
> - AC-1: `grep -q "prompt-history.mjs" docs/SHIP.md`
> - AC-2: `node scripts/prompt-history.mjs --logs logs --out PROMPT_HISTORY.md --dry-run`
> - AC-3: `bash -c 'test -f PROMPT_HISTORY.md && test -f docs/SHIP.md && grep -q "PROMPT_HISTORY.md" README.md'`
> - AC-4: `git check-ignore -q logs`
> 
> ## Targeted tests
> None — this task produces documents and one generated artifact; AC-2 re-runs the generator verification pass, which is the only executable check that applies.

## otel-judge-4i3.3

**Stop the prompt-history verifier from refusing text it already redacted** (bug, closed)

### Description

> ## Objective
> Make `scripts/prompt-history.mjs` complete a run over the real `logs/` corpus by removing the three verification false positives that currently make it refuse every generation, without weakening its fail-closed rule.
> 
> ## Behavioral context
> Before: `node scripts/prompt-history.mjs --logs logs --dry-run` exits 1 at `Unsafe content at grind-20260921-204743.log:36` and writes nothing. Measured over the 6,508-entry corpus, 147 entries trip verification and every one of them is a false positive; none carries a credential. No prompt history can be generated at all, so the ship-compliance disclosure cannot be published. After: the same command completes over the same corpus, a genuinely unredacted secret still stops the run and writes nothing, and each of the three false-positive shapes is pinned by a test.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> `sanitize` and `verifySanitized` in `scripts/prompt-history.mjs`, and the cases added to `test/prompt-history.test.ts` that pin each fixed shape.
> 
> ## Non-goals
> No change to `groupByBead`, `renderMarkdown`, or the document format; the grouping defect is a separate issue. No change to `docs/SHIP.md` or to publishing `PROMPT_HISTORY.md`, which otel-judge-4i3.2 owns. No editing or curation of the raw logs, which are the evidence the disclosure rests on. No new npm dependencies.
> 
> ## Concrete locations
> `scripts/prompt-history.mjs`: `verifySanitized(text, file, line)` — its `withoutMarkers` strip, its `credential` pattern and its `bearer` pattern; `sanitize(text, repoRoot)` — its `assignment` and `bearer` rules; `main()`, which turns a throw into exit 1. Tests live in `test/prompt-history.test.ts` under the existing `sanitize`, `refuses` and `grouping` describes. Evidence: `codegraph_explore` returned the verbatim source of these functions and named `test/prompt-history.test.ts` as the covering test for `main`, `renderMarkdown` and `groupByBead`.
> 
> ## Resolved decisions
> - Class one, 99 entries: `withoutMarkers` deletes each `[redacted]` marker, which glues the text on either side together. Prose such as "with Bearer [redacted] and no streaming" sanitizes to "Bearer [redacted] and no streaming" and strips to "Bearer [redacted]", which the Bearer [redacted] reads as an unredacted credential. Replace each marker with `]`, a character every pattern already excludes, instead of deleting it. Measured over the corpus, this alone takes the failures from 147 to 48, and it also stops two short runs from being glued into one 32-character `longValue` match.
> - Class two: the verify Bearer [redacted] is looser than the `[A-Za-z0-9._~+/-]` class `sanitize` redacts and is applied case-insensitively, so it matches the script's own declaration `const bearer = /\bBearer\s+.../` and documentation prose. Verification must refuse exactly the shape redaction claims to remove, so narrow the verify class to the class `sanitize` uses.
> - Class three: `sanitize` runs on literal log text while `verifySanitized` first decodes `\"` and `\uXXXX`, so an escaped `\"token\": [redacted]` — the test file's own fixture, quoted back inside a log — is invisible to redaction and visible to verification. Close the asymmetry on the redaction side by letting the `assignment` rule accept an optional backslash before each quote, so an escaped assignment is redacted like a bare one.
> - Decoding before redaction is rejected. The entry's own bytes are what gets published, and re-encoding a decoded copy would alter text the transcript exists to reproduce.
> - Class four, six entries: a key spelled `\u0074oken` is invisible to redaction for the same reason and visible to verification after decoding. Each character of a key is therefore matched as itself or as its `\u00xx` escape, with the backslash run counted loosely because a log that quotes a log escapes the escape.
> - The refusal fixture in `test/prompt-history.test.ts` used a unicode-escaped key, which class four now redacts, so it no longer demonstrates a survivor. It becomes an escaped separator, which redaction still cannot see and verification still decodes, and it is assembled from pieces so the test source is not itself a shape the verifier refuses once a log quotes this file back into the corpus.
> - Completing a full pass over the whole corpus is not a criterion here. With verification fixed, all 6,758 entries pass and `renderMarkdown` then throws `RangeError: Invalid string length` building the 852-section document, which is the grouping defect otel-judge-4i3.4 owns. This task is measured on the logs that previously refused.
> - Fail-closed is unchanged. Every fix removes matches that are provably not credentials; none adds a path that publishes one, and the refusal test from otel-judge-4i3.1 stays.
> 
> ## Compatibility constraints
> Node 20 or later with no npm dependencies, so the script still runs from a fresh clone. The output is committed to a public repository, so verification remains a security control rather than a formatting preference. The document format must not change: `parseExisting` refuses an append document that does not round-trip through `renderMarkdown` byte for byte.
> 
> ## Ordered steps
> 1. Replace the marker deletion in `verifySanitized` with the `]` sentinel.
> 2. Narrow the verify Bearer [redacted] to the class `sanitize` redacts.
> 3. Let the `assignment` rule in `sanitize` accept backslash-escaped quotes around the key and the value.
> 4. Match each key character as itself or as its `\u00xx` escape.
> 5. Add a test for each shape: redacted prose following `Bearer`, a lowercase `bearer =` declaration, an escaped assignment, and a unicode-escaped key.
> 6. Replace the refusal fixture with an escaped separator so it still demonstrates a survivor.
> 7. Keep a test proving a surviving credential shape still raises and writes nothing.
> 8. Re-run the generator over the logs that previously refused and confirm it completes.
> 
> ## Dependencies
> Blocks otel-judge-4i3.2, which cannot generate its document until this passes. Depends on nothing. Consumers: `main()` in the same file, and the ship checklist that runs the command.
> 
> ## Edge cases
> - A real credential sitting next to a redacted one must still raise; the sentinel must not become a way to hide a second secret on the same line.
> - An entry that is entirely redacted must pass, which is the case the `gap` comment in the file already documents for the assignment rule.
> - Escaped and bare assignments must both be redacted, including the double-escaped form that appears where a log quotes another log.
> - A line that merely names a rule in prose, such as "replace Bearer [redacted]", must not raise.
> - The corpus is 16 MB across 11 files, so the run must stay streaming and finish inside one worker window; it currently takes under a minute.
> 
> ## Plan-gap guidance
> If closing the escape asymmetry turns out to require decoding and re-encoding entry text — that is, if redaction can no longer preserve the bytes that get published — stop, record `PLAN-GAP` naming the entry shape that forces it, leave the other two fixes in place, and route to planning. Silently publishing re-encoded text would make the transcript something other than what the session produced, which is the one property the disclosure exists to provide.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The generator completes over the real logs that previously refused it.
> - AC-2 (proves-new): Redacted prose, a rule that names a credential shape, an escaped assignment, and a unicode-escaped key all pass verification.
> - AC-3 (guards-existing): A credential shape that survives redaction still stops the run and writes nothing.
> - AC-4 (guards-existing): The documented redaction shapes and the append round-trip still hold.
> - AC-5 (guards-existing): Raw logs remain gitignored and untracked.
> 
> ## Criterion checks
> - AC-1: `bash -c 'd="${TMPDIR:-/tmp}/ph-one"; rm -rf "$d"; mkdir -p "$d"; cp -f logs/grind-20260921-204743.log logs/grind-20260921-211843.log "$d"/; node scripts/prompt-history.mjs --logs "$d" --dry-run > /dev/null'`
> - AC-2: `npx vitest run test/prompt-history.test.ts -t "false positives"`
> - AC-3: `npx vitest run test/prompt-history.test.ts -t refuses`
> - AC-4: `npx vitest run test/prompt-history.test.ts -t sanitize`
> - AC-5: `git check-ignore -q logs`
> 
> ## Targeted tests
> `npx vitest run test/prompt-history.test.ts`

## otel-judge-4i3.4

**Group the prompt history by bead ids instead of any hyphenated word** (bug, in_progress)

### Description

> ## Objective
> Make the generated prompt history a document that can be committed and read: sections keyed to real bead ids, and a size a public repository can carry.
> 
> ## Behavioral context
> Before: `groupByBead` treats any lowercase hyphenated token as a bead id, so a full pass over `logs/` produces 852 sections of which only 35 are bead ids — the rest are ordinary words such as `claude-opus`, `re-read` and `top-level` — while about 3,300 entries fall under `unattributed`. Because each entry is repeated under every token it happens to mention, the largest entries are duplicated roughly twenty-five times and the rendered document is an estimated 397 MB. After: sections are bead ids or the single `unattributed` fallback, no entry is duplicated under a word that is not an issue, and a full pass over the same corpus produces a document small enough to commit.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The bead-id pattern and grouping in `groupByBead`, the flag that supplies the workspace prefix in `main`, and the grouping tests.
> 
> ## Non-goals
> No change to redaction or verification, which otel-judge-4i3.3 owns. No change to the rendered entry format or the append metadata, because an append document must keep round-tripping. No decision about which logs belong in a public disclosure; that stays with the ship review. No new npm dependencies.
> 
> ## Concrete locations
> `scripts/prompt-history.mjs`: `groupByBead(entries)` and its id regex, `main(args, repoRoot)` for the new flag, and `renderMarkdown(groups, now)` and `parseExisting(text)`, which consume the groups and must keep round-tripping. Tests: the `grouping` describe in `test/prompt-history.test.ts`. Evidence: `codegraph_explore` returned the verbatim source of `groupByBead`, `renderMarkdown`, `parseExisting` and `main`, and listed three in-file callers of `groupByBead` plus `test/prompt-history.test.ts` as its covering test.
> 
> ## Resolved decisions
> - The catch-all pattern is the defect. `\b[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-[a-z0-9]{3,8}(?:\.\d+)*\b` matches every hyphenated English word in a log, which is why 817 of the 852 sections are not issues. Match against an explicit workspace prefix instead: `<prefix>-[a-z0-9]{3,8}(\.\d+)*`.
> - Prefix-agnosticism was a deliberate decision in otel-judge-4i3.1 and is kept, but it is carried by a `--prefix <prefix>` flag rather than by a pattern that matches everything. The default is the repository directory name, which is how bd derives its own prefix and is `otel-judge` here.
> - An entry that names several bead ids is still filed under each of them, because attribution is the point of the document. With only real ids matching, the duplication factor falls from roughly twenty-five on the largest entries to a small constant.
> - `unattributed` stays the fallback and entries are never dropped, which keeps the disclosure complete and leaves the missing attributions visible for the hand pass the ship checklist describes.
> - Size is treated as an observable property of this fix rather than a separate task: if grouping is correct, a full pass over the current 16 MB corpus is bounded by the corpus itself plus a small duplication factor.
> 
> ## Compatibility constraints
> Node 20 or later with no npm dependencies. The rendered format is fixed by `parseExisting`, which refuses an append document that does not round-trip byte for byte through `renderMarkdown`, so heading text and entry metadata must keep their current shape. A document generated before this change groups under words rather than ids; it is regenerated rather than migrated, and the checklist already treats a full pass as overwriting.
> 
> ## Ordered steps
> 1. Add the `--prefix <prefix>` flag to the argument parser, defaulting to the repository directory name, and reject a missing value the way the other value flags do.
> 2. Thread the prefix into `groupByBead` and replace the catch-all id pattern with a prefix-anchored one.
> 3. Keep the `unattributed` fallback for entries that name no id.
> 4. Extend the `grouping` tests to cover two different prefixes, a child id such as `otel-judge-4i3.2`, an entry that names no id, and a hyphenated ordinary word that must not become a section.
> 5. Run a full pass over `logs/` and confirm the section list contains only ids and the fallback.
> 6. Confirm the generated document is small enough to commit.
> 
> ## Dependencies
> Blocks otel-judge-4i3.2, whose document this produces. Depends on otel-judge-4i3.3, because until verification stops refusing the corpus no full pass can be generated to inspect. Consumers: `renderMarkdown` and `parseExisting` in the same file, and the ship checklist that runs the command.
> 
> ## Edge cases
> - A prefix that itself contains hyphens, such as `otel-judge`, must still match child ids with dotted suffixes.
> - An id mentioned inside a longer token must not match; the pattern stays word-bounded.
> - An entry mentioning the same id twice must be filed once, which the existing `Set` already handles.
> - A log quoting an id from a different workspace must not create a section under the current prefix.
> - An empty logs directory must still render the explicit absence the existing test pins.
> 
> ## Plan-gap guidance
> If a correct full pass still produces a document too large to commit comfortably, stop, record `PLAN-GAP` naming the measured size and the largest contributing log, and route to the ship review. Deciding that some part of the corpus does not belong in a public disclosure is a content decision about the submitted artifact, not a grouping bug, and trimming the corpus inside this task would quietly change what the disclosure claims to be.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Grouping files entries under prefixed bead ids for more than one prefix, keeps child ids, and leaves unattributed entries in the fallback section.
> - AC-2 (proves-new): A full pass over the real corpus produces no section named after an ordinary hyphenated word.
> - AC-3 (proves-new): The document a full pass produces is under 25 MB.
> - AC-4 (guards-existing): A secret-shaped string that survives redaction still stops the run.
> - AC-5 (guards-existing): The documented redaction shapes and the append round-trip still hold.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/prompt-history.test.ts -t grouping`
> - AC-2: `bash -c 'out="${TMPDIR:-/tmp}/ph-sections.md"; node scripts/prompt-history.mjs --logs logs --out "$out" && ! grep -qE "^## (claude-opus|re-read|top-level)$" "$out"'`
> - AC-3: `bash -c 'out="${TMPDIR:-/tmp}/ph-size.md"; node scripts/prompt-history.mjs --logs logs --out "$out" && test "$(wc -c < "$out")" -lt 26214400'`
> - AC-4: `npx vitest run test/prompt-history.test.ts -t refuses`
> - AC-5: `npx vitest run test/prompt-history.test.ts -t sanitize`
> 
> ## Targeted tests
> `npx vitest run test/prompt-history.test.ts`

## otel-judge-4uq

**Epic: Scaffold the Wrangler project, Agent, and Worker door** (epic, open)

### Description

> Stand up a buildable Cloudflare Workers project in which the Worker door and the portable Agent are sibling runtimes colocated in one Wrangler project (PRD NFR4). Covers package and Wrangler configuration, the test harness, the HTTP router with health and CORS, and the Agent class skeleton with identity routing and live state. Outcome: every later epic has a compiling home and a runnable test command.

## otel-judge-4uq.1

**Scaffold Wrangler project with Agent, Workflow, and AI bindings** (task, closed)

### Description

> ## Objective
> Create the Wrangler plus TypeScript project skeleton so every later task has a buildable Cloudflare Workers project with the Agent Durable Object, Workflow, and Workers AI bindings declared.
> 
> ## Behavioral context
> Before: the repository holds prd/PRD.md, docs/DESIGN.md, and agent configuration only — there is nothing to build, typecheck, or deploy. After: a typecheck and a Wrangler dry-run build both succeed, and the generated env types expose the AI binding, the OTEL_JUDGE_AGENT Durable Object namespace, and the EVALUATE_WORKFLOW workflow binding.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> package.json with npm scripts, tsconfig.json, wrangler.jsonc with bindings and the SQLite Durable Object migration, placeholder entry modules for every class a binding references, and .gitignore entries for Wrangler local state.
> 
> ## Non-goals
> No router logic, no Agent behavior, no packet schema, no tests — each of those is a separate task. No CI workflow files and no deployment to a real Cloudflare account.
> 
> ## Concrete locations
> Create `package.json`, `tsconfig.json`, `wrangler.jsonc`, `src/index.ts` (default export object with `fetch()`), `src/agent/OtelJudgeAgent.ts` (exports class `OtelJudgeAgent`), and `src/workflow/EvaluateWorkflow.ts` (exports class `EvaluateWorkflow`). Edit `.gitignore`. Evidence: `codegraph_explore` returned "No relevant code found" for a repository-orientation query, so the index has zero symbols and all paths above are new files.
> 
> ## Resolved decisions
> - Stack is TypeScript on Cloudflare Workers with Wrangler v4 and the Cloudflare Agents SDK package `agents`. Install with `npm i agents` and let npm write the resolved version into package.json; do not hand-pin a version string.
> - Package manager is npm, so the lockfile is package-lock.json and every documented command uses `npx`.
> - Config format is `wrangler.jsonc` (not wrangler.toml) because the Agents SDK templates and the Durable Object migration blocks read more clearly in JSONC and comments are permitted.
> - Bindings: `AI` for Workers AI; Durable Object `OTEL_JUDGE_AGENT` bound to class `OtelJudgeAgent` with a first migration tag using `new_sqlite_classes` so `this.sql` is available; workflow binding `EVALUATE_WORKFLOW` bound to class `EvaluateWorkflow`; plain vars `LLAMA_MODEL` and `JEV_MODEL`.
> - The optional rate-limit KV namespace from the PRD is deliberately omitted from the MVP; body-size and quota limits are enforced in code instead, which keeps the project deployable with zero pre-created resources.
> - Secrets `TYPESAFE_API_KEY` and `FIREHOSE_SECRET` are never written into wrangler.jsonc; they are documented in the README and supplied via `.dev.vars` locally and `wrangler secret put` remotely (NFR1).
> - `compatibility_date` is `2026-09-01` and `compatibility_flags` is `["nodejs_compat"]`.
> 
> ## Compatibility constraints
> Targets the Cloudflare Workers runtime only; there is no Node.js server entry point and no Node built-in usage outside what nodejs_compat provides. The `new_sqlite_classes` migration must appear in the first migration tag — promoting a key-value Durable Object to SQLite later is a breaking migration. Local development must work with `npx wrangler dev` on Linux and macOS.
> 
> ## Ordered steps
> 1. Write package.json with name otel-judge, `"type": "module"`, and scripts dev, deploy, typecheck, test, and cf-typegen.
> 2. Install dependencies: `agents` as a dependency, and wrangler, typescript, vitest, @cloudflare/vitest-pool-workers, @cloudflare/workers-types as devDependencies.
> 3. Write tsconfig.json targeting ES2022 with `module` and `moduleResolution` set to bundler, `strict` true, and the Workers types included.
> 4. Write wrangler.jsonc with main src/index.ts, the compatibility date and flags, the AI binding, the OTEL_JUDGE_AGENT Durable Object binding plus its new_sqlite_classes migration, the EVALUATE_WORKFLOW workflow binding, and the LLAMA_MODEL and JEV_MODEL vars.
> 5. Add the three placeholder modules so every class named in wrangler.jsonc resolves at build time.
> 6. Append `.wrangler/`, `.dev.vars`, and `worker-configuration.d.ts` to .gitignore; node_modules, dist, and logs are already ignored by the existing ortus block.
> 7. Run the cf-typegen and typecheck scripts and fix any binding type errors before closing.
> 
> ## Dependencies
> No issue dependency — this is the root of the graph. Consumers are every other task: the router task imports from src/index.ts, the Agent task extends src/agent/OtelJudgeAgent.ts, and the workflow task extends src/workflow/EvaluateWorkflow.ts.
> 
> ## Edge cases
> - `npm i` requires network access; if the registry is unreachable the worker must report that failure rather than hand-authoring node_modules or vendoring.
> - Omitting new_sqlite_classes leaves `this.sql` undefined at runtime and would surface as a confusing failure inside the storage task; catch it here.
> - worker-configuration.d.ts must be regenerated whenever wrangler.jsonc bindings change, or later tasks will typecheck against stale env types.
> - A workflow binding whose class is not exported from the main module fails the dry-run build with a binding-resolution error rather than a type error.
> 
> ## Plan-gap guidance
> If the installed `agents` package does not export both `Agent` and `AgentWorkflow`, stop, record `PLAN-GAP` naming the installed version and the missing exports, leave package.json and wrangler.jsonc in place uncommitted, and route to planning. Do not substitute a bare DurableObject subclass or a raw WorkflowEntrypoint: FR2 (durable retried steps) and NFR4 (sibling runtimes in one project) depend on that SDK choice, and swapping it silently invalidates four downstream issues.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The project typechecks with zero errors against the generated Workers env types.
> - AC-2 (proves-new): A Wrangler dry-run build resolves the Agent Durable Object class and the Workflow entrypoint class and emits a bundle.
> - AC-3 (proves-new): Wrangler configuration declares the AI, Durable Object, and Workflow bindings.
> - AC-4 (guards-existing): The PRD and the historical DESIGN document are untouched by this task.
> 
> ## Criterion checks
> - AC-1: `npx tsc --noEmit`
> - AC-2: `npx wrangler deploy --dry-run --outdir dist`
> - AC-3: `grep -q "EVALUATE_WORKFLOW" wrangler.jsonc`
> - AC-4: `git diff --exit-code -- prd/PRD.md docs/DESIGN.md`
> 
> ## Targeted tests
> None — this task adds configuration and placeholder modules with no behavior; the vitest harness and the first behavioral tests land in the harness task that depends on this one.

## otel-judge-4uq.2

**Wire vitest to the Cloudflare Workers pool with a smoke test** (task, closed)

### Description

> ## Objective
> Give the repository one bounded, runnable test command by wiring vitest to the Cloudflare Workers pool against the project Wrangler configuration.
> 
> ## Behavioral context
> Before: there is no way to execute a test, so no later task can state a verifiable acceptance check. After: a single vitest invocation runs tests inside workerd with the real bindings available, and a smoke test proves the Worker fetch handler and the Durable Object namespace are reachable from test code.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> vitest.config.ts using the Workers pool, a test-scoped tsconfig, and one smoke test that exercises the Worker entry through the SELF binding and asserts the Agent namespace exists in env.
> 
> ## Non-goals
> No coverage thresholds, no CI wiring, no mocks library, and no tests for behavior that does not exist yet.
> 
> ## Concrete locations
> Create `vitest.config.ts` (calls `defineWorkersConfig()` from @[redacted]), `test/tsconfig.json`, and `test/smoke.test.ts` (imports `env` and `SELF` from `cloudflare:test`). Reads `wrangler.jsonc` and `src/index.ts` from the scaffold task. Evidence: CodeGraph index is empty (greenfield repo), so these are new files.
> 
> ## Resolved decisions
> - The single test runner is vitest with `@cloudflare/vitest-pool-workers`, configured to read `wrangler.jsonc` via `poolOptions.workers.wrangler.configPath`. One runner, one environment: pure-logic modules run in workerd too, which avoids maintaining a second node-environment project and keeps every test able to touch bindings.
> - Test invocations in acceptance criteria are always bounded to a specific file (`npx vitest run test/<name>.test.ts`); the whole-suite run is a human or CI action, never a worker default.
> - `singleWorker: true` is set so Durable Object tests share one isolate and stay deterministic.
> - Tests live in a top-level `test/` directory, one file per task, named after the unit under test.
> 
> ## Compatibility constraints
> The Workers pool requires a valid wrangler configuration and the same compatibility date and flags as production, so test behavior matches deploy behavior. Node-only APIs are unavailable in tests except through nodejs_compat. The pool needs the SQLite Durable Object migration already declared, otherwise storage tests in later issues cannot run.
> 
> ## Ordered steps
> 1. Add `vitest.config.ts` exporting `defineWorkersConfig({ test: { poolOptions: { workers: { singleWorker: true, wrangler: { configPath: "./wrangler.jsonc" } } } } })`.
> 2. Add `test/tsconfig.json` extending the root config and adding the `@cloudflare/vitest-pool-workers` types plus vitest globals.
> 3. Write `test/smoke.test.ts` that fetches `/` through `SELF` and asserts a Response is returned, and that asserts `env.OTEL_JUDGE_AGENT` is defined.
> 4. Point the package.json `test` script at `vitest run`.
> 5. Run the smoke test file and fix configuration errors until it passes.
> 
> ## Dependencies
> Depends on the scaffold task for wrangler.jsonc, src/index.ts, and the installed devDependencies. Consumers are every later task, each of which adds one bounded test file under test/.
> 
> ## Edge cases
> - A configPath pointing at a missing or invalid wrangler file fails pool startup with an opaque error; verify the path resolves from the repository root.
> - Durable Object tests fail with a storage error when the SQLite migration is absent — surface that here rather than in the storage task.
> - The smoke test must not assume any route exists yet; assert only that a Response comes back, with any status.
> 
> ## Plan-gap guidance
> If `@cloudflare/vitest-pool-workers` cannot start against the project wrangler configuration because the installed wrangler major version is incompatible with the installed pool version, stop, record `PLAN-GAP` naming both versions and the startup error, and route to planning. Do not fall back to a plain node-environment vitest config: every downstream acceptance check assumes bindings are reachable from tests, and silently removing workerd would make those checks unable to exercise the Agent at all.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The smoke test runs inside the Workers pool and passes, proving the Worker entry responds and the Agent Durable Object namespace is bound in the test environment.
> - AC-2 (proves-new): The vitest configuration reads the project Wrangler configuration rather than duplicating bindings.
> - AC-3 (guards-existing): The project still typechecks after the test tsconfig is added.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/smoke.test.ts`
> - AC-2: `grep -q "wrangler.jsonc" vitest.config.ts`
> - AC-3: `npx tsc --noEmit`
> 
> ## Targeted tests
> `npx vitest run test/smoke.test.ts`

## otel-judge-4uq.3

**Implement Worker door router with health, CORS allowlist, and body limits** (task, closed)

### Description

> ## Objective
> Implement the Worker door HTTP router: health, CORS allowlist, body-size limits, JSON error shape, and delegation of everything else to the Agents SDK request router.
> 
> ## Behavioral context
> Before: the Worker entry is a placeholder that returns a stub response for every path. After: GET /health returns a JSON readiness document without touching the Agent, oversize bodies are rejected with 413 before parsing, browser requests from the allowlisted demo origin receive CORS headers, agent-addressed paths reach the Agent through routeAgentRequest, and anything else returns a JSON 404.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The routing, CORS, limit, and error-shape layer of the Worker door, plus its bounded tests. This is edge concern only: routing, verification hooks, and limits.
> 
> ## Non-goals
> No evaluate logic, no packet validation, no Jev or Workers AI calls, and no firehose ingress route — ingress is a separate task in the ingress epic. No rate limiting against KV.
> 
> ## Concrete locations
> Rewrite `src/index.ts` to delegate to `handleRequest(request, env, ctx)` in new `src/worker/router.ts`. Create `src/worker/cors.ts` (exports `allowedOrigins(env)`, `corsHeaders(request, env)`, `handlePreflight()`), `src/worker/limits.ts` (exports `MAX_BODY_BYTES`, `enforceBodyLimit(request)`), and `src/worker/errors.ts` (exports `jsonError(code, message, status)`). Add `test/router.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `src/index.ts` exists only as the scaffold placeholder.
> 
> ## Resolved decisions
> - `MAX_BODY_BYTES` is 131072 (128 KiB). A request whose content-length exceeds it, or whose streamed body exceeds it, gets `jsonError("packet_too_large", ..., 413)` before any JSON parsing, so a hostile producer cannot force a large parse.
> - CORS origins come from the plain var `DEMO_ORIGINS`, a comma-separated list, defaulting to `https://who.github.io` when the var is absent. A request from a non-allowlisted origin is still processed (non-browser clients are legitimate) but receives no Access-Control-Allow-Origin header, so browsers block it. OPTIONS preflight from an allowlisted origin returns 204 with the allow headers.
> - `GET /health` returns 200 with `{ok: true, service: "otel-judge", version, bindings: {ai: true, agent: true, workflow: true}}` computed from the presence of env bindings. It never constructs or wakes an Agent, so health stays cheap.
> - All errors are JSON `{error, message}` with the correct status; the Worker never returns an HTML error body, because every channel consuming it is programmatic.
> - Unmatched paths fall through to `routeAgentRequest(request, env)` from the agents package; when that returns undefined, the router returns a JSON 404.
> - The router module imports nothing from src/agent/ except types, keeping the door and the Agent separable.
> 
> ## Compatibility constraints
> Runs on the Workers runtime; uses only the Fetch API and Web Crypto. The /health response shape is consumed by the demo repository and by uptime checks, so fields may be added but not renamed or removed. CORS behavior must permit the GitHub Pages demo origin without wildcarding, since credentials-bearing WebSocket upgrades are routed through the same door.
> 
> ## Ordered steps
> 1. Create `src/worker/errors.ts` with `jsonError()` returning a Response with content-type application/json.
> 2. Create `src/worker/limits.ts` with `MAX_BODY_BYTES` and `enforceBodyLimit(request)` returning either the buffered text or a 413 Response.
> 3. Create `src/worker/cors.ts` with `allowedOrigins(env)`, `corsHeaders(request, env)`, and `handlePreflight()`.
> 4. Create `src/worker/router.ts` with `handleRequest()` dispatching OPTIONS, GET /health, then `routeAgentRequest`, then a JSON 404, applying CORS headers to every response.
> 5. Reduce `src/index.ts` to a default export whose fetch delegates to `handleRequest`, re-exporting `OtelJudgeAgent` and `EvaluateWorkflow` so the bindings still resolve.
> 6. Write `test/router.test.ts` covering health, preflight from an allowlisted origin, an oversize body rejection, and the JSON 404.
> 7. Run the router test file and the typecheck.
> 
> ## Dependencies
> Depends on the scaffold task for wrangler.jsonc and the placeholder modules, and on the vitest harness task for a runnable test command. Consumers: the firehose ingress task adds routes to `handleRequest`, and the Agent accept path receives requests forwarded by `routeAgentRequest`.
> 
> ## Edge cases
> - A request with no content-length header but a large streamed body must still be capped; buffer with a byte counter rather than trusting the header.
> - OPTIONS from a non-allowlisted origin returns 204 with no allow headers rather than an error.
> - `routeAgentRequest` returning undefined must not be treated as a thrown error.
> - WebSocket upgrade requests must pass through to the Agent router untouched; do not buffer their bodies.
> - A missing `DEMO_ORIGINS` var must not throw; fall back to the documented default.
> 
> ## Plan-gap guidance
> If the installed agents package exports no `routeAgentRequest` equivalent for addressing an Agent by name over HTTP, stop, record `PLAN-GAP` naming the installed version and the exports it does provide, keep the health, CORS, and limit modules in place, and route to planning. Do not hand-roll Durable Object id derivation from the URL: identity routing is a normative PRD behavior shared with the ingress task, and two competing derivations would split the Agent namespace.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): GET /health returns 200 with a JSON body reporting the AI, Agent, and Workflow bindings, without instantiating an Agent.
> - AC-2 (proves-new): A request body larger than the configured limit is rejected with 413 and a JSON error code before parsing.
> - AC-3 (proves-new): An OPTIONS preflight from the allowlisted demo origin returns 204 with an Access-Control-Allow-Origin header, and an unknown path returns a JSON 404.
> - AC-4 (guards-existing): The project still typechecks and the Workers-pool smoke test still passes.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/router.test.ts -t health`
> - AC-2: `npx vitest run test/router.test.ts -t oversize`
> - AC-3: `npx vitest run test/router.test.ts -t cors`
> - AC-4: `npx vitest run test/smoke.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/router.test.ts`

## otel-judge-4uq.4

**Create portable Agent class with identity routing and live state snapshot** (task, closed)

### Description

> ## Objective
> Create the portable Agent class with its durable identity naming rule, its live state snapshot, and a schema-initialising start hook, with zero imports from any channel.
> 
> ## Behavioral context
> Before: `src/agent/OtelJudgeAgent.ts` is an empty placeholder that exists only so the Durable Object binding resolves. After: the class extends the Agents SDK Agent with a typed state, publishes an initial snapshot that any connected client can read, answers unsupported methods with a JSON 405, and exposes a deterministic naming function that maps a packet to exactly one durable Agent instance.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The Agent class shell, its state type and initial value, the identity naming helper, and bounded tests for naming and the initial state snapshot.
> 
> ## Non-goals
> No packet validation, no SQL tables, no dedupe, and no workflow start — those are tasks in the packet and workflow epics. No WebSocket message protocol beyond what setState broadcasts.
> 
> ## Concrete locations
> Rewrite `src/agent/OtelJudgeAgent.ts` (exports `class OtelJudgeAgent extends Agent<Env, JudgeState>` with `initialState`, `onStart()`, `onRequest()`). Create `src/agent/state.ts` (exports `JudgeState`, `Stage`, `INITIAL_STATE`) and `src/agent/identity.ts` (exports `slug()`, `agentNameForPacket()`, `DEFAULT_AGENT_NAME`). Add `test/agent-identity.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); the placeholder class came from the scaffold task.
> 
> ## Resolved decisions
> - State shape: `JudgeState = { agent_name: string; stage: Stage; packets_seen: number; last_packet_id: string | null; last_verdict: { severity: string; summary: string } | null; jev_status: "ok" | "unavailable" | null; updated_at: string }`, where `Stage` is one of `idle`, `accepted`, `summarized`, `jev`, `judging`, `complete`, `failed`.
> - State stays small and safe to broadcast. Full Jev distributions, prompts, and verdict prose live in SQL only, because setState reaches every connected WebSocket client and the demo origin is public.
> - Identity resolves the PRD open question "single demo instance versus per-service names": the MVP uses one Agent per service and environment. `agentNameForPacket(packet)` returns `` `${slug(packet.env)}:${slug(packet.service)}` ``, where `slug` lowercases and replaces any character outside `[a-z0-9-]` with `-`, collapses repeats, trims leading and trailing dashes, and truncates to 48 characters. Rationale: SQL history and live state must not interleave across services, and per-service identity is what a reviewer expects from a durable Agent.
> - `DEFAULT_AGENT_NAME` is `demo`, used only by documentation and the demo channel, never derived from packet data.
> - `onStart()` is the single place schema initialisation is invoked; in this task it is an empty hook with a comment naming the storage task that fills it, so there is exactly one designated call site.
> - `onRequest()` returns a JSON 405 for any method other than POST and a JSON 501 for POST, with a comment naming the accept-path task. The Agent never returns HTML.
> - The Agent module imports only from src/agent/, src/packet/ (types only, later), and the agents package. It imports nothing from src/worker/, src/ingress/, or any demo or Slack module (NFR3).
> 
> ## Compatibility constraints
> Runs as a SQLite-backed Durable Object on the Workers runtime. `agentNameForPacket` output is a durable identity key: changing the slug rule later strands existing SQL history under the old name, so the rule is frozen once packets have been stored. State is serialized to clients, so every field must be JSON-safe.
> 
> ## Ordered steps
> 1. Create `src/agent/state.ts` with the `Stage` union, the `JudgeState` interface, and `INITIAL_STATE`.
> 2. Create `src/agent/identity.ts` with `slug()`, `agentNameForPacket()`, and `DEFAULT_AGENT_NAME`.
> 3. Rewrite `src/agent/OtelJudgeAgent.ts` to extend `Agent<Env, JudgeState>`, set `initialState`, add the empty `onStart()` hook, and implement `onRequest()` with the 405 and 501 responses.
> 4. Confirm `src/index.ts` re-exports the class so the Durable Object binding still resolves.
> 5. Write `test/agent-identity.test.ts` covering slug normalisation, truncation, two services mapping to two names, and the initial state snapshot values.
> 6. Run the identity test file and the typecheck.
> 
> ## Dependencies
> Depends on the scaffold task for the Agent binding and migration, and on the vitest harness task for the test command. Consumers: the storage task fills `onStart`, the accept-path task fills `onRequest`, the ingress task calls `agentNameForPacket` at the Worker door, and the progress task writes to this state.
> 
> ## Edge cases
> - A service name of only punctuation must not slug to an empty string; fall back to `unknown` rather than producing a nameless Agent.
> - Very long service names must truncate deterministically so two different long names do not collide silently — truncate then append a short hash suffix when truncation occurred.
> - `packets_seen` must survive a cold start by being rehydrated from SQL later; in this task it starts at 0 and the storage task owns rehydration.
> - Unsupported HTTP methods must not fall through to the SDK default handler and return an opaque error.
> 
> ## Plan-gap guidance
> If the installed agents package types make `Agent<Env, State>` unusable as written — for example `setState` or `initialState` is absent — stop, record `PLAN-GAP` naming the installed version and the actual state API, keep `src/agent/identity.ts` and `src/agent/state.ts` in place, and route to planning. Do not substitute manual Durable Object storage for state: FR4 requires live state broadcast to connected clients, and a hand-rolled substitute would not reach the WebSocket clients the demo channel depends on.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Packets from two different services in the same environment map to two distinct Agent names, and hostile characters in a service name are normalised rather than passed through.
> - AC-2 (proves-new): A freshly constructed Agent publishes the documented initial state snapshot with stage idle and zero packets seen.
> - AC-3 (proves-new): The Agent module graph contains no import from the Worker door, the ingress layer, or any demo or Slack module.
> - AC-4 (guards-existing): The router health route and the Workers-pool smoke test still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/agent-identity.test.ts -t naming`
> - AC-2: `npx vitest run test/agent-identity.test.ts -t "initial state"`
> - AC-3: `bash -c '! grep -rEn "from .*(worker/|ingress/|slack|demo)" src/agent'`
> - AC-4: `npx vitest run test/router.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/agent-identity.test.ts`

## otel-judge-4uq.5

**Restore compatibility date 2026-09-01 when the Workers pool supports it** (task, in_progress)

### Description

> ## Objective
> 
> Return the project compatibility date to 2026-09-01 once a published @cloudflare/vitest-pool-workers ships a runtime that accepts it, so production runs on the intended date without breaking the test runtime.
> 
> ## Behavioral context
> 
> Before: wrangler.jsonc pins compatibility_date 2026-08-22 because the newest published pool (0.22.0) bundles miniflare 5.20260815.0-alpha, whose workerd rejects any date after 2026-08-22 and fails pool startup before collecting tests. After: the pool dependency is upgraded, wrangler.jsonc carries 2026-09-01 again, and the smoke test still starts inside workerd with real bindings.

### Design

> ## Readiness schema
> 
> v1
> 
> ## Scope
> 
> Bump the @cloudflare/vitest-pool-workers devDependency to a published version whose bundled runtime accepts 2026-09-01, set compatibility_date back to 2026-09-01 in wrangler.jsonc, and confirm the Workers pool still starts.
> 
> ## Non-goals
> 
> No change to compatibility_flags, no new test files, no migration of the runner away from @cloudflare/vitest-pool-workers, and no pinning to an unpublished or prerelease pool build.
> 
> ## Concrete locations
> 
> wrangler.jsonc (the compatibility_date key), package.json (the @cloudflare/vitest-pool-workers devDependency), and test/smoke.test.ts (the SELF.fetch() and env.OTEL_JUDGE_AGENT assertions that prove the pool started). vitest.config.ts already passes wrangler.jsonc through cloudflareTest(), so no config edit is expected. Evidence: CodeGraph reports no callers of these files outside test/.
> 
> ## Resolved decisions
> 
> - The test runtime and production share one compatibility date, so the date follows whatever the pool workerd supports rather than diverging between deploy and test.
> - 2026-08-22 is a deliberate temporary pin, not the intended production date; the current scaffold uses no feature gated after it.
> - The runner stays @cloudflare/vitest-pool-workers; a node-environment fallback is rejected because every downstream acceptance check needs bindings reachable from tests.
> 
> ## Compatibility constraints
> 
> workerd rejects a compatibility date newer than the server binary supports and fails pool startup before any test is collected. The project wrangler (4.136.1) already ships miniflare 5.20260921.0-alpha, so only the pool nested wrangler/miniflare pair gates the date. nodejs_compat must stay in compatibility_flags.
> 
> ## Ordered steps
> 
> 1. Run npm view @cloudflare/vitest-pool-workers versions --json and pick the newest published version above 0.22.0.
> 2. Install that version and confirm its nested miniflare version with npm ls miniflare.
> 3. Set compatibility_date to 2026-09-01 in wrangler.jsonc.
> 4. Run the bounded smoke test and confirm the pool starts and both assertions pass.
> 5. If no published pool accepts 2026-09-01, record PLAN-GAP with the versions and the startup error and leave the pin in place.
> 
> ## Dependencies
> 
> Depends on otel-judge-4uq.2, which created vitest.config.ts and test/smoke.test.ts and introduced the pin. Consumers are every later task whose acceptance check runs inside the Workers pool.
> 
> ## Edge cases
> 
> - No newer pool is published yet: the issue is not actionable and must stop at PLAN-GAP rather than raising the date and breaking every test.
> - A newer pool renames the cloudflareTest plugin API again: update vitest.config.ts in the same change so the pool still reads wrangler.jsonc.
> - The upgrade lands a runtime that accepts 2026-09-01 but changes a default behavior: the smoke test is the gate that catches it.
> 
> ## Plan-gap guidance
> 
> If the newest published pool still rejects 2026-09-01, stop, comment PLAN-GAP naming the pool version, its miniflare version, and the startup error, and leave wrangler.jsonc pinned. Do not raise the date without a runtime that accepts it, and do not switch the runner to a node environment to sidestep the check.

### Acceptance criteria

> ## Observable criteria
> 
> - AC-1 (proves-new): wrangler.jsonc declares compatibility date 2026-09-01.
> - AC-2 (guards-existing): The smoke test still starts inside the Workers pool and passes against that date.
> - AC-3 (guards-existing): The project still typechecks.
> 
> ## Criterion checks
> 
> - AC-1: grep -q "2026-09-01" wrangler.jsonc
> - AC-2: npx vitest run test/smoke.test.ts
> - AC-3: npx tsc --noEmit
> 
> ## Targeted tests
> 
> npx vitest run test/smoke.test.ts

## otel-judge-686

**Epic: README and channel-portability documentation** (epic, closed)

### Description

> Make the repository skimmable by a Cloudflare reviewer in under five minutes (PRD goal 1, FR5) and prove the drop-into-Slack property (PRD acceptance). Covers the README with the assignment mapping, architecture, pinned model ids, and demo link, plus the channel portability document backed by an automated import guard for NFR3.

## otel-judge-686.1

**Write the README for a five-minute reviewer skim** (task, closed)

### Description

> ## Objective
> Write the README that lets a Cloudflare reviewer understand, trust, and optionally run this repository in under five minutes, and that links the live demo without embedding its source.
> 
> ## Behavioral context
> Before: the repository has a PRD and a design history but no entry document, so a reviewer landing on the GitHub page has no orientation. After: the README opens with what the project is and the assignment mapping, shows the runtime flow, names the pinned model ids and the callable API, lists the secrets and the local and deploy commands, and links out to the separate demo repository.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> A single README covering orientation, the assignment mapping, architecture, the packet contract summary, the API surface, configuration, local development, deployment, and links.
> 
> ## Non-goals
> No demo application source or build configuration in this repository (PRD FR5). No tutorial-length prose, no screenshots, and no duplication of the PRD requirement list — the README links to it instead.
> 
> ## Concrete locations
> Create `README.md`. It references `src/index.ts`, `src/agent/OtelJudgeAgent.ts`, `src/workflow/EvaluateWorkflow.ts`, `src/jev/questions.ts`, `[redacted].json`, `prd/PRD.md`, and `docs/DESIGN.md`. Evidence: CodeGraph index is empty (greenfield repo); the README is new and every path it cites is created by an earlier task in this graph.
> 
> ## Resolved decisions
> - Section order is fixed: what this is; the Cloudflare assignment mapping table; architecture with the runtime flow; the packet contract in brief with a link to the fixture; the diamond model and the questions map; the callable API; configuration and secrets; local development; deploy; what this repository does not own; links.
> - The assignment mapping table is reproduced from the PRD verbatim, because that table is what a reviewer scans for first and a link would cost them a click.
> - The architecture section states plainly that the Worker door and the Agent are sibling runtimes colocated in one Wrangler project, not one nested inside the other, correcting the common mental model the PRD calls out as a non-goal.
> - Pinned ids are written in full: the Workers AI judge model and the System One model default, each with the var that overrides it, so a reviewer can see exactly what runs without reading code.
> - The demo link is the separate Pages repository URL and is marked as a live demo maintained elsewhere. No demo source, build step, or asset is added here.
> - `docs/DESIGN.md` is linked as decision history with an explicit note that the PRD wins when they disagree, matching the DESIGN document own rule.
> - Configuration lists `TYPESAFE_API_KEY` and `FIREHOSE_SECRET` as secrets set through Wrangler, and `LLAMA_MODEL`, `JEV_MODEL`, and `DEMO_ORIGINS` as plain vars, and states that no secret is ever in client-reachable configuration (NFR1).
> - Every command in the README is copy-pasteable and uses npx, matching the package-manager decision from the scaffold task.
> 
> ## Compatibility constraints
> The README is the submitted application artifact, so its claims must match the deployed behavior: a model id or command that drifts from the code is a correctness defect, not a documentation nit. The demo URL points at a separate repository whose lifecycle is independent, so the link is marked as external. Markdown must render correctly on GitHub without extensions.
> 
> ## Ordered steps
> 1. Write the opening paragraph and the one-line description of what the Agent evaluates and what it refuses to do.
> 2. Reproduce the Cloudflare assignment mapping table from the PRD.
> 3. Write the architecture section with the producer to door to Agent to workflow flow and the sibling-runtimes statement.
> 4. Summarise the packet contract and link the deploy-regression fixture as the example payload.
> 5. Document the diamond model, the five questions, and the no-hard-gates rule.
> 6. Document the callable history and label methods with their arguments and return shapes.
> 7. Document configuration, secrets, local development, and deploy commands.
> 8. Add the [redacted] section and the links to the demo repository, the PRD, and the design history.
> 9. Verify every cited path exists and every documented command is accurate.
> 
> ## Dependencies
> Depends on the progress and completion task and the callable history task, so the documented flow and API describe shipped behavior rather than intent. Consumers: the Cloudflare reviewer, the demo repository which links back, and the ship checklist task which adds the prompt-history link.
> 
> ## Edge cases
> - A cited file path that does not exist makes the README wrong on its first click; verify each one.
> - The demo URL may not be live yet at the time this is written; it is still written as the real URL with a short note, not as a placeholder token that could ship.
> - Command examples must not include a real secret value, even a fake-looking one.
> - The assignment mapping must stay consistent with the PRD; if the PRD changed, the README follows it rather than inventing a third version.
> 
> ## Plan-gap guidance
> If the demo repository URL is not yet decided, stop, record `PLAN-GAP` naming the unresolved URL and the README section that needs it, publish the rest of the README, and route to planning. Do not invent a plausible URL: the README is the submitted artifact and a dead link in it is worse than a documented gap.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The README exists and names the pinned Workers AI judge model id in full.
> - AC-2 (proves-new): The README links the separate demo repository and contains no demo application source or build configuration in this repository.
> - AC-3 (proves-new): The README links the design history document and the PRD, and states that the PRD wins when they disagree.
> - AC-4 (proves-new): Every source path the README cites exists in the repository.
> - AC-5 (guards-existing): The full behavioral surface the README describes still passes its tests.
> 
> ## Criterion checks
> - AC-1: `grep -q "@cf/meta/llama-3.3-70b-instruct-fp8-fast" README.md`
> - AC-2: `grep -q "otel-judge-demo" README.md`
> - AC-3: `grep -q "docs/DESIGN.md" README.md`
> - AC-4: `bash -c 'grep -oE "(src|fixtures|prd|docs)/[A-Za-z0-9_./-]+" README.md | sort -u | xargs -I{} test -e {}'`
> - AC-5: `npx vitest run test/history-api.test.ts`
> 
> ## Targeted tests
> None — the README carries no executable logic; AC-4 checks its path claims and AC-5 re-runs the behavior it documents.

## otel-judge-686.2

**Document channel portability and enforce the Agent import boundary** (task, closed)

### Description

> ## Objective
> Document the channel-portability contract and enforce it with an automated guard so the Agent can never acquire a dependency on a specific channel.
> 
> ## Behavioral context
> Before: the drop-into-Slack property is an aspiration stated in the PRD with nothing preventing a convenient import from breaking it. After: a written procedure shows exactly which files a new channel adds and which it deletes, and a test fails the build the moment any module under the Agent or workflow directories imports the Worker door, the ingress layer, or a named channel.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The channel document and one static source-scanning test that enforces the import boundary.
> 
> ## Non-goals
> No Slack adapter implementation — the PRD places it in the future and this task only proves the boundary holds. No runtime dependency injection framework and no build-time module boundary tooling.
> 
> ## Concrete locations
> Create `docs/CHANNELS.md` and `test/portability.test.ts` (contains the scan over `src/agent/` and `src/workflow/`). References `src/agent/OtelJudgeAgent.ts`, `src/ingress/otlp.ts`, and `src/worker/router.ts` as the concrete add-and-delete surface. Evidence: CodeGraph index is empty (greenfield repo); the import boundary is currently held only by the review habit established in the Agent class task.
> 
> ## Resolved decisions
> - The guard is a static source scan, not a runtime or bundle check. Bundling inlines modules and would hide the violation; reading the source text catches it at the moment it is written, which is when it is cheapest to fix.
> - The scan reads every `.ts` file under `src/agent/` and `src/workflow/` and fails on any import specifier matching `src/worker/`, `src/ingress/`, `slack`, `pages`, or `demo`. Type-only imports are treated the same as value imports, because a type dependency still couples the Agent to a channel shape.
> - Test files are scanned too, except the portability test itself, so a test convenience import cannot normalise the violation.
> - The file list is enumerated by a static import map maintained alongside the test, because tests run in workerd where there is no filesystem. The test asserts the map covers every file it expects to find, so a newly added Agent module cannot escape the scan by being forgotten.
> - `docs/CHANNELS.md` documents the drop-into-Slack test as a concrete diff: delete `src/ingress/otlp.ts` and its route, remove the demo origin from the CORS allowlist, add `src/ingress/slack.ts` with signature verification and a Slack-event-to-packet translation, and add one route. The Agent class, the workflow, the store, and the callable API are untouched, and the document says so explicitly with the file list.
> - The document also states the inverse: what a channel may not do, namely reach into the store directly, add a field to live state, or import anything from `src/agent/` other than the identity helper and the callable API types.
> 
> ## Compatibility constraints
> The guard runs in the same Workers test pool as every other test. The documented boundary is a claim in the submitted README and the PRD acceptance list, so the document and the test must agree; if the test is relaxed, the document must be edited in the same change. The import map must be updated whenever a module is added under the scanned directories, which the coverage assertion enforces.
> 
> ## Ordered steps
> 1. Write `test/portability.test.ts` with the static import map of Agent and workflow source text.
> 2. Implement the specifier scan with the documented forbidden patterns, covering both value and type-only import forms.
> 3. Add the coverage assertion so a missing file in the map fails the test.
> 4. Run the test and confirm it passes against the current source.
> 5. Add a deliberate violation locally, confirm the test fails, and revert it.
> 6. Write `docs/CHANNELS.md` with the add-and-delete file list for the Slack case and the explicit may-not list.
> 7. Link the document from the README channel section.
> 8. Run the portability test file and the typecheck.
> 
> ## Dependencies
> Depends on the OTLP adapter task and the callable history task, because the boundary is only meaningful once there is channel-specific code and a channel-agnostic API to contrast it with. Consumers: every later change to the Agent is checked by this test, and the README links the document.
> 
> ## Edge cases
> - A dynamic import expression must be caught as well as a static one, since it couples the same way.
> - A re-export form must be caught, because it is an import in effect.
> - A comment mentioning slack must not trigger a failure; the scan matches import specifiers, not arbitrary text.
> - A relative specifier that resolves into the forbidden directories through a parent path must be caught, not just literal directory names.
> - The test must fail loudly when the import map is stale rather than silently scanning fewer files than exist.
> 
> ## Plan-gap guidance
> If a genuinely necessary shared module would have to live under `src/worker/` and be imported by the Agent, stop, record `PLAN-GAP` naming the module, both consumers, and why it cannot move to a neutral directory, keep the guard in place, and route to planning. Do not add an exception to the scan: the boundary is a stated acceptance criterion of the PRD, and the first exception is what makes the second one easy.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The portability test passes against the current source, proving no Agent or workflow module imports the Worker door, the ingress layer, or a named channel.
> - AC-2 (proves-new): The test fails when its import map is stale, so a newly added Agent module cannot escape the scan.
> - AC-3 (proves-new): The channels document exists and names the concrete files a Slack channel adds and deletes.
> - AC-4 (guards-existing): The README still passes its path-claim check after the channels link is added.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/portability.test.ts -t boundary`
> - AC-2: `npx vitest run test/portability.test.ts -t coverage`
> - AC-3: `grep -q "src/ingress/slack.ts" docs/CHANNELS.md`
> - AC-4: `bash -c 'grep -oE "(src|fixtures|prd|docs)/[A-Za-z0-9_./-]+" README.md | sort -u | xargs -I{} test -e {}'`
> 
> ## Targeted tests
> `npx vitest run test/portability.test.ts`

## otel-judge-7e9

**Retire the agent-identity test that still expects a 501 from the accept path** (task, closed)

### Description

> ## Objective
> Bring `test/agent-identity.test.ts` back in line with the accept path that has since landed, so a clean checkout has no failing test.
> 
> ## Behavioral context
> Before: `test/agent-identity.test.ts > direct requests > answers a POST with a JSON 501 until the accept path lands` asserts a 501 placeholder response that `OtelJudgeAgent.onRequest` stopped returning once packet validation shipped; the Agent now answers an unrecognised POST body with a 400 and a validation error list, so the test fails on every run. After: the direct-request tests assert what the Agent actually answers, and the file passes.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The one stale assertion in `test/agent-identity.test.ts` and whatever wording around it still describes a not-yet-built accept path.
> 
> ## Non-goals
> No change to `OtelJudgeAgent.onRequest` or to packet validation — the runtime behaviour is correct and the test is the thing that drifted. No rework of the other direct-request cases that already pass.
> 
> ## Concrete locations
> Edit the `describe("direct requests")` block in `test/agent-identity.test.ts`, specifically the case named "answers a POST with a JSON 501 until the accept path lands". The behaviour it should assert is in `OtelJudgeAgent.onRequest` in `src/agent/OtelJudgeAgent.ts`, which routes an unparseable or invalid body through `acceptPacket` in `src/agent/accept.ts` and answers 400 with an `errors` array. Evidence: `codegraph_explore` on `OtelJudgeAgent onRequest acceptPacket` shows the 501 branch no longer exists; the failing assertion reads `expected 400 to be 501`.
> 
> ## Resolved decisions
> - The test is rewritten rather than deleted: a POST that reaches the Agent with a body it cannot accept is worth an assertion, and the 400-with-error-list shape is the contract a producer codes against.
> - The 405 case in the same block stays exactly as it is; only the POST case moved.
> 
> ## Compatibility constraints
> None — this is a test-only change and no stored data, binding, or public shape moves with it.
> 
> ## Ordered steps
> 1. Run `npx vitest run test/agent-identity.test.ts` and confirm the 501 case is the only failure.
> 2. Rewrite that case to POST a body the validator rejects and assert the 400 status and the `errors` array the accept path returns.
> 3. Rename the case so its title no longer says "until the accept path lands".
> 4. Re-run the file.
> 
> ## Dependencies
> Depends on nothing: the accept path it is out of step with already landed. Consumers: none — no other test or source file reads this case.
> 
> ## Edge cases
> - An empty POST body and a syntactically valid but schema-invalid body take different branches inside `acceptPacket`; the rewritten case must pick one deliberately rather than relying on whichever it happens to hit.
> - The other cases in the file share Durable Object instances by name, so a rewritten case must not reuse a name another case seeded.
> 
> ## Plan-gap guidance
> If the 501 branch turns out to still be reachable through some path, stop and record `PLAN-GAP`: that would mean the Agent has two different answers for one situation, which is a source decision rather than a test fix.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The direct-request POST case asserts the status and error body the accept path actually returns, and no case title still refers to a 501 placeholder.
> - AC-2 (guards-existing): The rest of `test/agent-identity.test.ts` still passes, including the 405 case and the cold-start snapshot.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/agent-identity.test.ts -t requests`
> - AC-2: `npx vitest run test/agent-identity.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/agent-identity.test.ts`

## otel-judge-9f0

**Epic: Packet contract, validation, dedupe, and SQL memory** (epic, closed)

### Description

> Define the normalized packet the Agent accepts (PRD Packet contract, FR1), the SQLite tables that hold packets, System One answers, Llama verdicts and human labels (FR3), the dedupe-and-fast-ack accept path, and the fixture packets that exercise every judge path. Outcome: the Agent can accept, reject, deduplicate, and durably remember packets without any evaluation logic yet.

## otel-judge-9f0.1

**Define normalized packet schema and strict dependency-free validator** (task, closed)

### Description

> ## Objective
> Define the normalized packet contract the Agent accepts and a strict, dependency-free validator that returns typed errors instead of throwing.
> 
> ## Behavioral context
> Before: nothing constrains what a producer may send, so raw OpenTelemetry trees could reach the Agent. After: only payloads matching the frozen packet schema are accepted; unknown top-level fields, missing signals, malformed windows, and oversize arrays are rejected with a list of field-level error strings the caller can render.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The packet TypeScript types, the strict validator, the typed error shape, and bounded tests for accept and reject paths.
> 
> ## Non-goals
> No storage, no dedupe, no HTTP handling, and no OTLP translation — those are separate tasks. No JSON Schema document is published in this task.
> 
> ## Concrete locations
> Create `src/packet/types.ts` (exports `Packet`, `PacketSignals`, `TopSpan`, `PacketWindow`, `RecentDeploy`, `PACKET_SCHEMA_VERSION`), `src/packet/validate.ts` (exports `validatePacket(input: unknown): ValidationResult`), and `src/packet/errors.ts` (exports `ValidationResult`, `PacketErrorCode`). Add `test/packet-validate.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - The frozen MVP schema, all fields required unless marked optional:
>   `schema_version` (number, must equal 1), `packet_id` (string, 1 to 128 chars, `[A-Za-z0-9._:-]` only), `service` (string, 1 to 64), `env` (one of `prod`, `staging`, `dev`), `window` (`{start, end}`, both ISO 8601 UTC strings, end strictly after start), `signals` (`{error_rate, error_rate_baseline, p95_latency_ms, p95_latency_baseline_ms, request_rate_rps, slo_burn_rate}` plus optional `saturation: {cpu_pct?, mem_pct?, queue_depth?}`), `top_spans` (array, max 20, each `{name, count, error_count, p95_ms}`), `exemplar_trace_ids` (array of string, max 10), `alert_labels` (array of string, max 20), optional `recent_deploy` (`{version, deployed_at, minutes_ago}`), optional `log_snippets` (array, max 10, each at most 500 characters).
> - Numeric ranges: the two rate fields are 0 to 1 inclusive; latency, request rate, burn rate, and percentages are finite and at least 0; percentages are 0 to 100.
> - `schema_version` is required and checked. It is the versioning seam with the separate firehose repository: renaming or retyping any field requires bumping it, and the validator must reject a version it does not implement rather than best-effort parsing.
> - Validation is hand-written TypeScript, not zod or any schema library. Rationale: it keeps the Worker bundle small, avoids a dependency whose availability cannot be verified offline, and lets error strings name the exact JSON path.
> - Unknown top-level keys are rejected (strict mode) so a producer cannot smuggle a raw OTLP tree into the Agent as an extra field. Unknown keys inside `signals.saturation` are also rejected; unknown keys inside `top_spans` entries are dropped rather than rejected, because span exporters legitimately add attributes.
> - `validatePacket` never throws. It returns `{ok: true, packet}` with a normalised, structurally cloned packet, or `{ok: false, errors: string[]}` where each error reads like `signals.error_rate: expected number between 0 and 1, received "high"`.
> - Normalisation on accept: `service` is trimmed, `alert_labels` are deduplicated and sorted, and `exemplar_trace_ids` are lowercased. Nothing else is coerced — a string where a number belongs is an error, not a conversion.
> 
> ## Compatibility constraints
> This contract is the wire format between the separate producer repository and this Agent, and it is what the demo channel renders. Fields may be added as optional without a version bump; renaming, retyping, or making an optional field required requires bumping `PACKET_SCHEMA_VERSION` and rejecting older versions explicitly. Stored packets in SQL keep the schema version they arrived with.
> 
> ## Ordered steps
> 1. Write `src/packet/errors.ts` with `PacketErrorCode` and the `ValidationResult` union.
> 2. Write `src/packet/types.ts` with the interfaces above and `PACKET_SCHEMA_VERSION = 1`.
> 3. Write `src/packet/validate.ts` with small field checkers (`requireString`, `requireNumberInRange`, `requireIsoTimestamp`, `requireArrayMax`) and compose them in `validatePacket`, accumulating every error rather than failing on the first.
> 4. Implement strict unknown-key rejection at the top level and inside `signals` and `signals.saturation`.
> 5. Apply the documented normalisation to the returned packet.
> 6. Write `test/packet-validate.test.ts` covering a valid packet, an unknown top-level key, an out-of-range error rate, a reversed window, an oversize top_spans array, a wrong schema version, and the multi-error accumulation.
> 7. Run the validation test file and the typecheck.
> 
> ## Dependencies
> Depends on the vitest harness task for a runnable test command. Consumers: the storage task persists the validated packet, the accept-path task calls `validatePacket`, the summarize step reads `Packet` fields, the fixtures task asserts against it, and the OTLP adapter produces values that must satisfy it.
> 
> ## Edge cases
> - `NaN` and `Infinity` must be rejected even though `typeof` reports number.
> - A window whose end equals its start is invalid; a window longer than 24 hours is valid but flagged in the error-free result as no error, since long windows are legitimate backfills.
> - An empty `top_spans` array is valid: a quiet service still produces packets.
> - Duplicate entries in `alert_labels` are deduplicated, not rejected.
> - A log snippet longer than 500 characters is an error, not a silent truncation, so producers learn about it.
> - A payload that is an array or a primitive rather than an object must return a single clear error rather than crashing on property access.
> 
> ## Plan-gap guidance
> If a downstream consumer requires a field that this frozen schema does not carry — for example the demo channel needs a per-span baseline that the producer cannot emit — stop, record `PLAN-GAP` naming the field, the consumer, and the producer that would have to emit it, leave the validator at schema version 1, and route to planning. Do not add the field ad hoc: the schema is a cross-repository contract and an unversioned addition would silently diverge the two repositories.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): A well-formed packet validates successfully and comes back normalised, with deduplicated sorted alert labels.
> - AC-2 (proves-new): An unknown top-level key, a wrong schema version, and a non-object payload are each rejected with a specific error string rather than an exception.
> - AC-3 (proves-new): Out-of-range, non-finite, and reversed-window values are rejected, and multiple errors in one payload are all reported together.
> - AC-4 (guards-existing): The Agent identity tests and the Workers-pool smoke test still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/packet-validate.test.ts -t "valid packet"`
> - AC-2: `npx vitest run test/packet-validate.test.ts -t strict`
> - AC-3: `npx vitest run test/packet-validate.test.ts -t ranges`
> - AC-4: `npx vitest run test/agent-identity.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/packet-validate.test.ts`

## otel-judge-9f0.2

**Create Agent SQLite schema and typed store helpers** (task, closed)

### Description

> ## Objective
> Create the Agent SQLite schema and the typed store helpers that persist packets, System One runs and answers, Llama verdicts, and human labels.
> 
> ## Behavioral context
> Before: the Agent has no memory; a cold start loses everything. After: the Agent creates its tables idempotently on every start, and callers can insert a packet, record a System One run with its full probability vectors, record a verdict, add a human label, and read recent history back — all through named functions rather than inline SQL.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The DDL, the store function surface, rehydration of the live counter on start, and bounded tests exercising insert and read paths inside a real Durable Object.
> 
> ## Non-goals
> No HTTP handling, no dedupe policy decision (the accept-path task owns the response semantics), no workflow, and no migration framework — the MVP schema is created idempotently and not versioned in SQL.
> 
> ## Concrete locations
> Create `src/agent/store.ts` exporting `ensureSchema(sql)`, `insertPacket(sql, packet, receivedAt)`, `hasPacket(sql, packetId)`, `recordJevRun(sql, run)`, `recordJevAnswers(sql, packetId, answers)`, `recordVerdict(sql, packetId, verdict)`, `recordHumanLabel(sql, packetId, label, note)`, `listRecentPackets(sql, limit)`, `getPacketRecord(sql, packetId)`, and `countPackets(sql)`. Call `ensureSchema` and `countPackets` from `OtelJudgeAgent.onStart()` in `src/agent/OtelJudgeAgent.ts`. Add `test/store.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `onStart` exists as an empty designated hook from the Agent class task.
> 
> ## Resolved decisions
> - Tables, created with CREATE TABLE IF NOT EXISTS:
>   `packets(packet_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, service TEXT NOT NULL, env TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL)`;
>   `jev_runs(packet_id TEXT PRIMARY KEY, model TEXT, status TEXT NOT NULL, reason TEXT, latency_ms INTEGER, created_at TEXT NOT NULL)`;
>   `jev_answers(id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id TEXT NOT NULL, question_key TEXT NOT NULL, answer_json TEXT NOT NULL, created_at TEXT NOT NULL)`;
>   `verdicts(packet_id TEXT PRIMARY KEY, severity TEXT NOT NULL, summary TEXT, critique TEXT, next_action TEXT, disagrees_with_prior INTEGER, model TEXT, raw_json TEXT NOT NULL, created_at TEXT NOT NULL)`;
>   `human_labels(id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id TEXT NOT NULL, label TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL)`.
> - Indexes: `idx_packets_received_at ON packets(received_at DESC)`, `idx_jev_answers_packet ON jev_answers(packet_id)`, `idx_labels_packet ON human_labels(packet_id)`.
> - `jev_answers.answer_json` stores the complete probability vector plus the noul mass for that question, exactly as System One returned it. An argmax may be stored as an additional key inside the same JSON object but must never replace the vector — PRD requires full distributions to reach System Two and to survive in history (FR3).
> - `jev_runs` is separate from `jev_answers` so an unavailable or failed System One call is recorded as a first-class row (`status` one of `ok`, `unavailable`, `error`) with no answer rows at all, rather than being encoded as a fake answer.
> - `packets.status` is one of `accepted`, `evaluating`, `complete`, `failed`, updated by the workflow completion task.
> - Access is the Agents SDK `this.sql` tagged template only; no ORM and no raw Durable Object storage API. Store functions take the tagged-template callable as their first argument so they are testable against a real Agent instance.
> - `ensureSchema` is idempotent and runs on every cold start from `onStart`; `countPackets` rehydrates `packets_seen` into live state so the broadcast counter survives eviction.
> - Timestamps are ISO 8601 UTC strings, not epoch integers, because they are rendered directly by the demo channel.
> 
> ## Compatibility constraints
> SQLite-backed Durable Objects only; requires the `new_sqlite_classes` migration from the scaffold task. Stored rows are durable data: columns may be added with a follow-up IF NOT EXISTS path, but renaming or dropping a column strands existing history and is out of bounds for this task. `payload_json` retains the packet exactly as validated, including its `schema_version`, so an older packet remains readable after a schema bump.
> 
> ## Ordered steps
> 1. Write `src/agent/store.ts` with `ensureSchema` issuing the five CREATE TABLE IF NOT EXISTS statements and the three CREATE INDEX IF NOT EXISTS statements.
> 2. Add the row type interfaces and the insert helpers, serialising JSON columns with JSON.stringify and parsing on read.
> 3. Add `hasPacket`, `listRecentPackets` (newest first, limit clamped to 100), `getPacketRecord` (packet plus jev run, answers, verdict, and labels), and `countPackets`.
> 4. Call `ensureSchema(this.sql)` from `OtelJudgeAgent.onStart()`, then `countPackets` and merge the count into live state.
> 5. Write `test/store.test.ts` using the Workers pool to construct the Agent, insert a packet, record a jev run with a full vector, record a verdict and a label, and read the record back.
> 6. Assert in the test that a distribution round-trips with every outcome key and the noul mass intact.
> 7. Run the store test file and the typecheck.
> 
> ## Dependencies
> Depends on the packet schema task for the `Packet` type and on the Agent class task for the `onStart` hook and live state. Consumers: the accept-path task calls `hasPacket` and `insertPacket`, the workflow completion task calls `recordJevRun`, `recordJevAnswers`, and `recordVerdict`, and the callable history task calls `listRecentPackets` and `getPacketRecord`.
> 
> ## Edge cases
> - Inserting a packet id that already exists must be prevented by the caller checking `hasPacket`; the primary key constraint is the backstop and its error must surface as a typed duplicate, not a 500.
> - `listRecentPackets` with a limit of 0 or a negative limit returns an empty array rather than every row.
> - `getPacketRecord` for an unknown id returns null rather than throwing.
> - A verdict recorded twice for the same packet (workflow retry after partial completion) must upsert rather than fail, so replay is safe.
> - Reading a row whose `answer_json` is corrupt must return a typed parse error for that answer only, not abort the whole record read.
> - `ensureSchema` running concurrently on a cold start must be safe; the IF NOT EXISTS form covers this.
> 
> ## Plan-gap guidance
> If `this.sql` is unavailable on the Agent instance at runtime despite the SQLite migration being declared, stop, record `PLAN-GAP` naming the agents package version and the actual storage surface the instance exposes, leave the DDL in `src/agent/store.ts`, and route to planning. Do not fall back to key-value Durable Object storage: FR3 requires queryable history and the callable history task depends on SQL reads, so a key-value substitute would silently break a documented acceptance criterion.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Schema creation runs twice on the same Agent without error, and a packet inserted afterwards reads back with its payload intact.
> - AC-2 (proves-new): A System One run recorded with full probability vectors round-trips with every outcome key and the noul mass preserved, and an unavailable run is stored with no answer rows.
> - AC-3 (proves-new): A verdict recorded twice for one packet upserts rather than failing, and a human label attaches to the packet record.
> - AC-4 (guards-existing): The packet validator tests and the Agent identity tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/store.test.ts -t schema`
> - AC-2: `npx vitest run test/store.test.ts -t distribution`
> - AC-3: `npx vitest run test/store.test.ts -t verdict`
> - AC-4: `npx vitest run test/packet-validate.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/store.test.ts`

## otel-judge-9f0.3

**Implement packet accept path with dedupe and fast acknowledgement** (task, closed)

### Description

> ## Objective
> Implement the Agent accept path: validate an incoming packet, deduplicate it by packet id, persist it, publish the accepted stage, and return a fast acknowledgement without doing the evaluation inline.
> 
> ## Behavioral context
> Before: posting to the Agent returns a JSON 501 placeholder. After: a new valid packet is stored and acknowledged with 202 within one round trip while evaluation proceeds separately, a repeat of the same packet id is acknowledged with 200 and marked duplicate without re-storing or re-evaluating, and an invalid body returns 400 with the validator error list.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> `OtelJudgeAgent.onRequest` for POST, the accept helper, the dedupe decision, the state transition to accepted, and the designated seam where evaluation is started.
> 
> ## Non-goals
> No workflow implementation — this task installs the seam and leaves its body a logged no-op that the workflow completion task replaces. No OTLP translation and no request authentication, which belong to the Worker door.
> 
> ## Concrete locations
> Edit `src/agent/OtelJudgeAgent.ts` to implement `onRequest(request)` for POST and add `protected async startEvaluate(packet: Packet): Promise<void>`. Create `src/agent/accept.ts` exporting `acceptPacket(ctx, body)` and the `AcceptOutcome` union. Uses `validatePacket()` from `src/packet/validate.ts` and `hasPacket`/`insertPacket` from `src/agent/store.ts`. Add `test/accept.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `onRequest` currently returns the 501 placeholder installed by the Agent class task.
> 
> ## Resolved decisions
> - Response contract: new packet returns 202 with `{accepted: true, duplicate: false, packet_id, agent, stage: "accepted"}`; repeat packet id returns 200 with `{accepted: false, duplicate: true, packet_id, status}` where status is the stored `packets.status`; validation failure returns 400 with `{error: "invalid_packet", errors: [...]}`; a body over the limit returns 413 with `{error: "packet_too_large"}`.
> - The accept path is deliberately fast: validate, dedupe, one insert, one setState, start the evaluation seam, return. It must not await the evaluation. This is the PRD requirement that evaluate is not a single giant synchronous onRequest body.
> - Dedupe is by `packet_id` alone, checked with `hasPacket` before insert, with the primary key as the backstop. Identical content under a new id is a new packet: producers own idempotency keys.
> - 202 is returned even though the workflow may later fail, because the packet is durably stored and its outcome is observable through state and the history API. Failure is reported via stage `failed`, not via the ack.
> - The Agent re-checks the body size against the same `MAX_BODY_BYTES` constant used at the door, by importing the constant only, so a direct Agent call that bypasses the door is still bounded. The constant is re-exported from `src/packet/limits.ts` and the Worker door imports it from there, so the Agent keeps zero imports from `src/worker/` (NFR3).
> - `startEvaluate` in this task logs the packet id and returns; it carries a comment naming the workflow completion task as its owner. This is the designated seam so two tasks do not both define how evaluation starts.
> - State transition on accept sets `stage: "accepted"`, `last_packet_id`, increments `packets_seen`, and refreshes `updated_at`.
> 
> ## Compatibility constraints
> The acknowledgement JSON shape is consumed by the firehose producer and rendered by the demo channel, so fields may be added but not renamed. Status codes are part of the contract: producers treat 202 and 200 as success and must not retry either. Runs on the Workers runtime inside a Durable Object.
> 
> ## Ordered steps
> 1. Move `MAX_BODY_BYTES` into `src/packet/limits.ts` and re-point `src/worker/limits.ts` at it, keeping the door behavior unchanged.
> 2. Write `src/agent/accept.ts` with `acceptPacket` performing size check, validation, dedupe, insert, and returning the `AcceptOutcome`.
> 3. Implement `onRequest` POST handling in `src/agent/OtelJudgeAgent.ts`, mapping each outcome to its status and JSON body.
> 4. Update live state on the accepted outcome and call `this.startEvaluate(packet)` without awaiting the evaluation result.
> 5. Add the `startEvaluate` seam with its logged no-op body and owner comment.
> 6. Write `test/accept.test.ts` covering first accept (202 and one stored row), duplicate (200, still one stored row), invalid body (400 with error list), and oversize body (413).
> 7. Run the accept test file and the typecheck.
> 
> ## Dependencies
> Depends on the packet schema task for `validatePacket` and on the storage task for `hasPacket` and `insertPacket`. Consumers: the firehose ingress task forwards requests here, and the workflow completion task replaces the `startEvaluate` body.
> 
> ## Edge cases
> - Two concurrent requests carrying the same packet id must result in exactly one stored row; the second must surface as a duplicate rather than a 500 from the primary key.
> - A body that is valid JSON but not an object must return 400 with the validator message, not a crash.
> - A body that is not JSON at all must return 400 with a parse error rather than propagating the exception.
> - An insert failure after successful validation must return 500 with a JSON error and must not set the accepted stage.
> - A duplicate packet must not increment `packets_seen` or move the stage.
> 
> ## Plan-gap guidance
> If the required response semantics conflict with what the firehose producer expects — for example the producer treats any non-200 as a retryable failure and would storm on 202 — stop, record `PLAN-GAP` naming both contracts and the observed producer behavior, keep the accept path as specified, and route to planning. Do not change the documented status codes unilaterally: they are the cross-repository contract the demo channel also renders.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Posting a new valid packet returns 202 with the accepted acknowledgement and stores exactly one row.
> - AC-2 (proves-new): Posting the same packet id again returns 200 marked duplicate and leaves the stored row count unchanged.
> - AC-3 (proves-new): An invalid body returns 400 carrying the validator error list, and an oversize body returns 413 without being parsed.
> - AC-4 (guards-existing): The store tests and the router tests still pass, proving the shared limit constant move broke neither side.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/accept.test.ts -t accepts`
> - AC-2: `npx vitest run test/accept.test.ts -t duplicate`
> - AC-3: `npx vitest run test/accept.test.ts -t rejects`
> - AC-4: `npx vitest run test/router.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/accept.test.ts`

## otel-judge-9f0.4

**Add fixture packets covering every judge path plus an invalid case** (task, closed)

### Description

> ## Objective
> Provide committed fixture packets that exercise every judge path plus one deliberately invalid packet, and assert them against the validator so the fixtures cannot silently drift from the schema.
> 
> ## Behavioral context
> Before: every test constructs packet literals inline, so the schema has no shared reference payloads and the README cannot point at a runnable example. After: four fixture files live under fixtures/packets/, a test proves the three valid ones validate and the invalid one fails with named errors, and later tasks build their scenarios from these files instead of re-inventing payloads.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> Four fixture JSON files, a small loader used by tests, and a bounded test that validates all of them.
> 
> ## Non-goals
> No chaos or randomised generation — packet generation belongs to the separate producer repository and is explicitly out of this repository (PRD FR7). No fixtures for OTLP payloads, which the ingress epic owns.
> 
> ## Concrete locations
> Create `[redacted].json`, `fixtures/packets/noise-flap.json`, `[redacted].json`, `[redacted].json`, and `test/fixtures.test.ts` (exports a `loadFixture(name)` helper used by later test files). Validated by `validatePacket()` from `src/packet/validate.ts`. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - Exactly four fixtures, each chosen to exercise a distinct judge path rather than to cover schema permutations:
>   `deploy-regression-sev1` — service checkout, env prod, error rate 0.21 against a 0.004 baseline, p95 1180 ms against 240 ms, `recent_deploy` 7 minutes ago, two error-heavy spans, alert labels including `http-5xx`; the obvious deploy-related severity one.
>   `noise-flap` — service search, env prod, error rate 0.012 against a 0.009 baseline, p95 within 8 percent of baseline, no recent deploy, one flapping alert label; the case where the judge should land on noise and disagree with an alarmist alert label.
>   `saturation-sev0` — service payments, env prod, error rate 0.47, slo burn rate 14.2, `saturation` with cpu 97 percent and queue depth 8400, no recent deploy; the severity zero non-deploy path that tests the saturation root-cause family.
>   `invalid-missing-signals` — omits `signals.p95_latency_baseline_ms` and carries an unknown top-level key `raw_otlp`; it must produce two distinct errors, proving both the required-field and strict-unknown-key rules.
> - Fixtures are committed JSON files, not TypeScript literals, so the demo repository and manual curl invocations can reuse them verbatim.
> - `loadFixture` reads fixtures through a static import map rather than filesystem access, because tests run inside workerd where there is no filesystem.
> - Every valid fixture carries `schema_version: 1` and a stable, human-readable `packet_id` such as `fix-deploy-regression-001`, so a fixture posted twice exercises the dedupe path on purpose.
> 
> ## Compatibility constraints
> Fixture packet ids are stable identifiers referenced by README examples and by later test names; renaming one breaks those references. Fixtures must remain valid against `PACKET_SCHEMA_VERSION`, so a schema bump requires updating all three valid fixtures in the same change. JSON only — no comments, since producers parse them with a plain JSON parser.
> 
> ## Ordered steps
> 1. Write the three valid fixture files with realistic, internally consistent signal values and windows.
> 2. Write the invalid fixture with exactly the two documented defects.
> 3. Write `test/fixtures.test.ts` with the static import map and the `loadFixture` helper.
> 4. Assert each valid fixture validates and its normalised output keeps its packet id and schema version.
> 5. Assert the invalid fixture fails and that the error list names both `signals.p95_latency_baseline_ms` and `raw_otlp`.
> 6. Run the fixtures test file and the typecheck.
> 
> ## Dependencies
> Depends on the packet schema task for `validatePacket` and the frozen field list. Consumers: the summarize task, the judge task, and the end-to-end workflow tests all load these fixtures, and the README points at the deploy-regression fixture as its example payload.
> 
> ## Edge cases
> - A fixture that drifts out of schema must fail this test loudly rather than being auto-corrected.
> - The invalid fixture must fail for exactly the two intended reasons; an accidental third defect makes the test assert the wrong thing.
> - Fixture windows must be internally consistent (end after start) or the deploy-regression case fails for the wrong reason.
> - Importing JSON from a test in workerd requires `resolveJsonModule`; enable it in tsconfig if the import fails rather than inlining the payloads.
> 
> ## Plan-gap guidance
> If a fixture cannot be made both realistic and schema-valid — for example the saturation case needs a signal field the frozen schema does not carry — stop, record `PLAN-GAP` naming the fixture, the missing field, and the judge path it was meant to exercise, keep the fixtures that do validate, and route to planning. Do not weaken the validator to admit the fixture: the schema is the cross-repository contract and the fixture exists to test it, not the reverse.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): All three valid fixtures pass validation and retain their packet ids and schema version after normalisation.
> - AC-2 (proves-new): The invalid fixture is rejected with errors naming both the missing baseline field and the unknown top-level key.
> - AC-3 (proves-new): The three valid fixture files exist on disk as parseable JSON usable by an external producer.
> - AC-4 (guards-existing): The validator tests still pass unchanged.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/fixtures.test.ts -t valid`
> - AC-2: `npx vitest run test/fixtures.test.ts -t invalid`
> - AC-3: `node -p "JSON.parse(require('fs').readFileSync('[redacted].json','utf8')).packet_id"`
> - AC-4: `npx vitest run test/packet-validate.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/fixtures.test.ts`

## otel-judge-crm

**Stop the whole-suite run from timing out a different test on each pass** (bug, closed)

### Description

> ## Objective
> Make `npx vitest run` over the whole repository produce the same verdict twice in a row, so a full run is evidence rather than a coin flip.
> 
> ## Behavioral context
> Before: individual test files pass when run alone, but a whole-suite run fails one arbitrary case per pass with `Test timed out in 5000ms` after roughly twenty seconds of wall clock — `test/fixtures.test.ts` on one run, `test/agent-identity.test.ts` on the next, `test/jev-client.test.ts` on the one after. Which case is hit moves between runs, so a full run cannot be used to tell a regression from noise. After: a whole-suite run either passes or fails for a reason that reproduces.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The Workers pool configuration in `vitest.config.ts` and whatever in the Durable Object setup makes a run slower the more Agent instances a suite has created.
> 
> ## Non-goals
> No rewriting of the individual test files to work around the flake, and no blanket raise of `testTimeout` to hide it — a five-second budget for a local SQLite read is generous already, so a test that needs longer is reporting something real. Not a fix for the unrelated failing cases in `test/agent-identity.test.ts` (see the bead for the stale 501 assertion) or for `test/prompt-history.test.ts`.
> 
> ## Concrete locations
> `vitest.config.ts` sets `maxWorkers: 1` and `isolate: false` as the Vitest 4 stand-in for the pool former `singleWorker` option, so every file in a run shares one workerd instance and every Durable Object created by `env.OTEL_JUDGE_AGENT.get(...)` stays alive for the rest of it. The suites that create the most instances are the `withAgent` helpers in `test/store.test.ts`, `test/progress.test.ts`, and `test/history-api.test.ts`. Evidence: running those three files alone passes; adding them to a whole-suite run is what moves the timeout around.
> 
> ## Resolved decisions
> - The flake predates the history API work: a whole-suite run at commit 40f23c2 already failed `test/fixtures.test.ts` this way.
> - Diagnosis comes before configuration changes. `isolate: false` was chosen deliberately and turning it off should follow a measurement, not precede one.
> 
> ## Compatibility constraints
> Whatever changes, `runInDurableObject` and `SELF.fetch` must both keep working, since the suites use both to reach an Agent.
> 
> ## Ordered steps
> 1. Run `npx vitest run` three times and record which case times out each time.
> 2. Re-run with `isolate: true` and compare, to establish whether shared instance lifetime is the cause.
> 3. If it is, decide between per-file isolation and giving each suite Durable Object names it disposes of, and write the reasoning into the config comment.
> 4. Confirm the chosen fix with three consecutive whole-suite runs.
> 
> ## Dependencies
> None — no issue blocks this and no source file depends on the pool configuration. Consumers: every test file in the repository runs under this configuration.
> 
> ## Edge cases
> - A run that passes three times is not proof; the failing case moves, so the check has to be repetition rather than a single green run.
> - Turning isolation on may slow the suite enough to be its own problem, which is why step 3 is a decision rather than a foregone conclusion.
> 
> ## Plan-gap guidance
> If the timeouts turn out to come from the AI binding warning about remote access rather than from instance lifetime, stop and record `PLAN-GAP`: making tests reach a remote binding is a cost and credentials decision, not a test configuration one.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Three consecutive whole-suite runs fail the same set of cases, with no case timing out in one run and passing in another.
> - AC-2 (guards-existing): The three suites that create the most Durable Objects still pass when run together.
> 
> ## Criterion checks
> - AC-1: `bash -c "for i in 1 2 3; do npx vitest run --reporter=json --outputFile=/tmp/run-$i.json; done; node -e 1"`
> - AC-2: `npx vitest run test/store.test.ts test/progress.test.ts test/history-api.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/store.test.ts test/progress.test.ts test/history-api.test.ts`

## otel-judge-css

**Add --llm-compact to prompt-history (Claude/ortus grind backend)** (feature, closed)

### Description

> ## Objective
> 
> Add an optional `--llm-compact` flag to `scripts/prompt-history.mjs` that uses the same Claude / ortus grind backend already available on [redacted-machine] to rewrite the sanitized prompt history into a compact sequence of markdown sections (not raw JSON entry dumps), with repeated session-start prompts deduplicated once at the top of the file and marked as repeated elsewhere.
> 
> ## Behavioral context
> 
> Before: `node scripts/prompt-history.mjs` writes `PROMPT_HISTORY.md` as bead-grouped entries that each carry both an `<!-- entry {...} -->` JSON metadata line and a quoted body, producing a ~46 MB document that is hard to review and fails the ship-size intent. After: with `--llm-compact`, the same command still sanitizes and verifies first, then calls the Claude/ortus grind backend to compact the content into readable markdown; Claude decides which blocks are session-start prompts, places one copy under a top section that states those starters are repeated elsewhere, and replaces `PROMPT_HISTORY.md` with that compact document. Without the flag, the existing raw generator path remains for local debug. Ship-gate / `otel-judge-4i3.2` must invoke `--llm-compact` when publishing the disclosure.

### Design

> ## Readiness schema
> 
> v1
> 
> ## Scope
> 
> CLI flag `--llm-compact` on `scripts/prompt-history.mjs`, the Claude/ortus grind backend invocation used to compact and dedupe, the top-of-file session-start section shape, tests covering flag parsing and compact contract, and notes for `docs/SHIP.md` / `otel-judge-4i3.2` that ship must pass the flag.
> 
> ## Non-goals
> 
> No change to sanitize / verifySanitized rules. No Workers AI or Anthropic HTTP client as the compact backend. No second output filename — compact replaces `PROMPT_HISTORY.md`. No requirement that the raw path disappear. No decision to trim which log files belong in the corpus (that stays with ship review). No making `--llm-compact` the default for bare CLI runs.
> 
> ## Concrete locations
> 
> `scripts/prompt-history.mjs`: `main(args, repoRoot)` argument parser and write path; new compact step after `verifySanitized` and before/instead of raw `renderMarkdown` when the flag is set. `test/prompt-history.test.ts`: flag parsing and compact-output contract tests (mock the Claude backend). Ship consumers: `otel-judge-4i3.2` / future `docs/SHIP.md` command lines. Evidence: prior grind comments on `4i3.4` and live `--help` confirm defaults `--logs logs/` `--out PROMPT_HISTORY.md` `--prefix <repo dirname>`.
> 
> ## Resolved decisions
> 
> - Backend is the same Claude / ortus grind backend already used on [redacted-machine] for this repo’s grinds, not Workers AI and not a separate Anthropic HTTP path.
> - Output replaces `PROMPT_HISTORY.md` (same `--out` default); there is no `PROMPT_HISTORY.compact.md`.
> - Claude’s compact pass decides what counts as a session-start prompt; those starters appear once at the top with an explicit note that they are repeated elsewhere in the corpus.
> - `--llm-compact` stays optional on the CLI; ship-gate and `otel-judge-4i3.2` must use it for the committed disclosure.
> - Sanitization and verification still run before any LLM call so unsafe content never reaches the model or the committed file.
> - Compact markdown must not reintroduce secret-shaped strings; run the existing verifier over the compact output before rename.
> 
> ## Compatibility constraints
> 
> Node 20+; existing flags `--logs`, `--out`, `--prefix`, `--append`, `--dry-run`, `--help` keep their meanings. `--append` plus `--llm-compact` must either be rejected with a clear error or defined so append round-trip still holds — prefer reject with a clear error unless append can be proven safe. Raw logs stay gitignored. Claude/ortus grind backend must be reachable from the [redacted-machine] environment where ship runs; if it is missing, stop with PLAN-GAP rather than inventing another provider.
> 
> ## Ordered steps
> 
> 1. Add `--llm-compact` to the argument parser in `main` and document it in `--help`.
> 2. Keep the existing collect → sanitize → verify pipeline unchanged before any compact call.
> 3. Wire a Claude/ortus grind backend call that receives sanitized grouped content and returns compact markdown with a top session-start section.
> 4. Instruct that pass to place repeated session-start prompts once at the top and mark them as repeated elsewhere; Claude decides membership.
> 5. Verify the compact markdown with `verifySanitized` (and refuse unsafe output) before writing.
> 6. Write via the existing temp-file + rename path to `--out` (default `PROMPT_HISTORY.md`).
> 7. Reject combining `--append` with `--llm-compact` unless a proven round-trip design is added in the same change.
> 8. Extend `test/prompt-history.test.ts` with a mocked backend covering flag parsing, top session-start section, and verifier-on-compact-output.
> 9. Record in notes or a short comment on `otel-judge-4i3.2` that ship must run with `--llm-compact`.
> 
> ## Dependencies
> 
> Depends on `otel-judge-4i3.1` (generator exists) and should follow `otel-judge-4i3.4` grouping so compact input is bead-keyed. Blocks `otel-judge-4i3.2` publishing until compact is available for the ship command. Parent epic: `otel-judge-4i3`. Consumers: ship checklist and Cloudflare application disclosure reviewers.
> 
> ## Edge cases
> 
> - Claude/ortus grind backend missing or failing: exit non-zero; do not leave a partial `PROMPT_HISTORY.md`.
> - Compact output still contains secret-shaped strings: verifier refuses; no write.
> - Empty `logs/`: compact still produces a valid small markdown document (or explicit absence), never a crash.
> - `--dry-run` with `--llm-compact`: print compact markdown to stdout without writing.
> - `--append` with `--llm-compact`: clear error unless explicitly supported.
> - Model returns non-markdown or strips required top session-start section: fail closed and do not write.
> 
> ## Plan-gap guidance
> 
> If the Claude/ortus grind backend cannot be invoked from a non-interactive ship script without a new auth path, or if compact output cannot be made verifier-safe without changing sanitize rules, stop, record PLAN-GAP with the exact failure, leave the raw generator path working, and route to human handling. Do not switch to Workers AI or another provider to bypass the locked backend decision.

### Acceptance criteria

> ## Observable criteria
> 
> - AC-1 (proves-new): `--help` documents `--llm-compact`.
> - AC-2 (proves-new): With `--llm-compact` and a mocked Claude/ortus grind backend, `PROMPT_HISTORY.md` is replaced by compact markdown that includes a top session-start section marking repeats, and does not emit raw `<!-- entry` JSON dumps as the primary body form.
> - AC-3 (proves-new): Compact output is passed through `verifySanitized` before write; unsafe compact text refuses the run and leaves the previous file untouched when present.
> - AC-4 (guards-existing): Without `--llm-compact`, the existing raw generator path and its tests still pass.
> - AC-5 (guards-existing): Combining `--append` with `--llm-compact` exits non-zero with a clear error (unless append support is implemented and tested in the same change).
> 
> ## Criterion checks
> 
> - AC-1: `bash -c 'node scripts/prompt-history.mjs --help | grep -q llm-compact'`
> - AC-2: `npx vitest run test/prompt-history.test.ts -t llm-compact`
> - AC-3: `npx vitest run test/prompt-history.test.ts -t llm-compact-unsafe`
> - AC-4: `npx vitest run test/prompt-history.test.ts -t grouping`
> - AC-5: `bash -c 'node scripts/prompt-history.mjs --append --llm-compact --logs fixtures/empty-logs --out /tmp/ph-append-compact.md; test $? -ne 0'`
> 
> ## Targeted tests
> 
> `npx vitest run test/prompt-history.test.ts -t llm-compact`

## otel-judge-h3c

**Epic: Firehose ingress at the Worker door** (epic, closed)

### Description

> Give producers a verified way in without putting channel knowledge inside the Agent (PRD ownership split, FR7). Covers the signed /ingest route with quota limits and identity derivation, and the OTLP/JSON to packet adapter that lives in the Worker door only. Outcome: telemetry reaches the Agent as a normalized packet and the Agent still sees nothing but the contract.

## otel-judge-h3c.1

**Add signed firehose ingress route with identity derivation and quota limits** (task, closed)

### Description

> ## Objective
> Add the verified firehose ingress route at the Worker door that authenticates a producer, derives the Agent identity from the packet, and forwards it to the right durable instance.
> 
> ## Behavioral context
> Before: only a client that already knows the Agent addressing scheme can submit a packet, and nothing authenticates a producer. After: a producer posts a signed packet to one stable path, an unsigned or wrongly signed request is refused, an oversize body is refused before parsing, and a valid request is routed to the Agent instance named for its service and environment with the Agent acknowledgement returned unchanged.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The ingress route, HMAC verification, the disabled-without-secret behavior, identity derivation, forwarding, and bounded tests.
> 
> ## Non-goals
> No OTLP translation, which is the next task. No rate limiting against KV, deliberately deferred by the scaffold decision. No changes to the Agent accept semantics.
> 
> ## Concrete locations
> Edit `src/worker/router.ts` to dispatch `POST /ingest` to new `handleIngest(request, env)`. Create `src/ingress/verify.ts` (exports `FIREHOSE_SIGNATURE_HEADER`, `verifyFirehoseRequest(rawBody, request, env)`) and `src/ingress/forward.ts` (exports `forwardToAgent(env, agentName, rawBody)`). Uses `agentNameForPacket()` from `src/agent/identity.ts`, `validatePacket()` from `src/packet/validate.ts`, `MAX_BODY_BYTES` from `src/packet/limits.ts`, and `getAgentByName` from the agents package. Add `test/ingest.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `handleRequest` comes from the router task.
> 
> ## Resolved decisions
> - The route is `POST /ingest` and accepts exactly the normalized packet contract, not OTLP. It is the stable path the producer repository codes against.
> - Verification is an HMAC-SHA256 of the raw request body under the `FIREHOSE_SECRET` secret, sent as lowercase hex in the `x-firehose-signature` header. Comparison uses `crypto.subtle.timingSafeEqual` over equal-length buffers, with a length check first that returns false rather than throwing.
> - HMAC over a shared secret is chosen over Bearer [redacted] because the producer is a service, the body is small, and signing binds the credential to the payload so a captured header cannot be replayed against a different packet.
> - When `FIREHOSE_SECRET` is unset, `/ingest` returns 503 with `{error: "ingress_disabled"}`. It never falls open. An unconfigured deployment refusing traffic is strictly better than an open ingest path on a public URL (NFR1).
> - Order of operations is fixed: body-size check, signature verification, JSON parse, packet validation, identity derivation, forward. Verification precedes parsing so an unauthenticated caller cannot make the Worker parse attacker-controlled JSON.
> - Identity is `agentNameForPacket(packet)`, the same function the Agent uses, imported from `src/agent/identity.ts`. There is exactly one derivation in the codebase, so the door and the Agent can never disagree about which instance owns a packet.
> - The Agent response is returned to the producer unchanged, including its status, so the producer sees 202, 200 duplicate, or 400 exactly as the Agent decided. The door adds no envelope.
> - Failure statuses: 413 oversize, 401 bad or missing signature, 400 unparseable or invalid packet, 503 ingress disabled.
> 
> ## Compatibility constraints
> The path, the header name, the hex encoding, and the status codes form the contract with the separate producer repository; changing any of them requires a coordinated change there. Web Crypto HMAC and timingSafeEqual are available on the Workers runtime. The secret is supplied through Wrangler secrets and never appears in wrangler.jsonc, logs, or error bodies.
> 
> ## Ordered steps
> 1. Add `handleIngest` dispatch for `POST /ingest` in `src/worker/router.ts`, before the Agent router fallthrough.
> 2. Write `src/ingress/verify.ts` importing the HMAC key with Web Crypto, computing the digest over the raw body, and comparing in constant time after a length check.
> 3. Implement the ingress-disabled branch returning 503 when the secret is absent.
> 4. Buffer the body with the shared size limit before verification and reject oversize with 413.
> 5. Parse and validate the packet, returning 400 with the validator errors on failure.
> 6. Derive the Agent name, obtain the instance with `getAgentByName`, and forward the raw body as a POST.
> 7. Return the Agent response unchanged, with CORS headers applied by the router.
> 8. Write `test/ingest.test.ts` covering a valid signed packet reaching the right Agent name, a wrong signature, a missing header, an unset secret, an oversize body, and an invalid packet.
> 9. Assert in the tests that verification happens before parsing by sending an unparseable body with a bad signature and expecting 401 rather than 400.
> 10. Run the ingest test file and the typecheck.
> 
> ## Dependencies
> Depends on the router task for `handleRequest` and the limit constant, on the Agent identity task for the naming function, on the packet schema task for validation, and on the accept-path task for the Agent behavior being forwarded to. Consumers: the OTLP adapter task reuses `handleIngest` after translation, and the producer repository posts to this route.
> 
> ## Edge cases
> - A signature of the wrong length must return 401 rather than throwing inside the constant-time comparison.
> - A body that is valid JSON but fails packet validation must return 400 after a successful signature check, proving the order is right.
> - Two packets for different services in one burst must reach two different Agent instances.
> - A signature computed over a re-serialised body rather than the raw bytes will not match; the handler must sign and verify the exact received bytes.
> - An empty body with a valid signature over the empty string must fail packet validation with 400, not crash.
> - The 401 and 503 responses must not echo the secret or any part of it.
> 
> ## Plan-gap guidance
> If the producer repository has already shipped a different authentication scheme — a Bearer [redacted], or a signature over a canonicalised body rather than raw bytes — stop, record `PLAN-GAP` naming the observed scheme and where it is specified, keep this route behind the ingress-disabled branch, and route to planning. Do not accept both schemes to be accommodating: two accepted credentials double the attack surface on a public ingest path, and that is a security decision, not an implementation detail.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): A correctly signed valid packet is forwarded to the Agent instance named for its service and environment, and the Agent acknowledgement is returned unchanged.
> - AC-2 (proves-new): A wrong signature, a missing signature header, and an unparseable body with a bad signature all return 401 before any parsing occurs.
> - AC-3 (proves-new): With no firehose secret configured the route returns 503 and never falls open, and an oversize body returns 413 before verification work.
> - AC-4 (proves-new): Exactly one Agent-name derivation exists in the codebase and the ingress path imports it rather than duplicating it.
> - AC-5 (guards-existing): The router tests and the accept-path tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/ingest.test.ts -t forwards`
> - AC-2: `npx vitest run test/ingest.test.ts -t signature`
> - AC-3: `npx vitest run test/ingest.test.ts -t disabled`
> - AC-4: `grep -rn "agentNameForPacket" src`
> - AC-5: `npx vitest run test/router.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/ingest.test.ts`

## otel-judge-h3c.2

**Translate OTLP JSON exports into normalized packets at the Worker door** (task, closed)

### Description

> ## Objective
> Translate OTLP/JSON metric exports into the normalized packet contract at the Worker door, so the Agent continues to see only the contract.
> 
> ## Behavioral context
> Before: a producer must already speak the normalized packet contract, so a standard OpenTelemetry collector cannot target this Worker. After: a collector can post an OTLP/JSON metrics export with an accompanying baselines block to a dedicated path, the door translates it into a normalized packet and routes it through the same verified ingest path, and a translation that cannot be completed is refused with a specific reason instead of a guessed packet.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The OTLP/JSON to packet adapter, its dedicated route, the required baselines contract, and bounded tests over a recorded OTLP sample.
> 
> ## Non-goals
> No protobuf decoding, no trace or log signal support in the MVP, no metric aggregation across multiple exports, and no changes to the Agent, which must remain unaware this adapter exists.
> 
> ## Concrete locations
> Create `src/ingress/otlp.ts` (exports `OtlpIngestBody`, `otlpToPacket(body, opts)`, `AdapterError`) and add `POST /ingest/otlp` dispatch to `handleRequest` in `src/worker/router.ts`. Create `fixtures/otlp/checkout-metrics.json`. Add `test/otlp-adapter.test.ts`. Reuses `verifyFirehoseRequest()` from `src/ingress/verify.ts` and `handleIngest` forwarding from the ingress route task. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - Accepts OTLP/JSON `ExportMetricsServiceRequest` shaped bodies with a `resourceMetrics` array. Protobuf is out of scope: decoding it needs a dependency and the producer repository emits JSON, so supporting both would double the surface for no MVP benefit.
> - `service` comes from the `service.name` resource attribute and `env` from `deployment.environment`, mapped onto the three allowed environment values; an unrecognised environment is an adapter error, not a silent default to prod.
> - The evaluation window comes from the data point `startTimeUnixNano` and `timeUnixNano`, converted to ISO 8601 UTC.
> - Error rate is derived from the request-count metric split by the `error.type` attribute presence; p95 latency is read from the duration histogram bucket boundaries by locating the bucket containing the 95th percentile of the cumulative counts and reporting its upper bound.
> - Baselines are not derivable from a single OTLP export. The request body must carry a sibling `baselines` object with `error_rate`, `p95_latency_ms`, and optional `slo_burn_rate`, and the adapter returns a 400 adapter error naming the missing field when it is absent. Inventing a baseline would make every delta in the summary meaningless while looking plausible, which is exactly the failure this refuses.
> - `packet_id` is derived deterministically as a hex SHA-256 over service, env, and the window bounds, truncated to 32 characters. Deterministic derivation means a collector retry deduplicates naturally through the existing packet-id dedupe rather than creating a second packet.
> - The adapter is a pure function returning either a packet or an `AdapterError` with a machine token and a human message; it performs no network calls and no crypto.
> - The route reuses the same HMAC verification and size limit as the normalized route, then translates, then forwards through the same Agent-forwarding helper.
> - `src/ingress/otlp.ts` is imported only by `src/worker/router.ts`. The Agent must never import it: this is the concrete instance of the PRD drop-into-Slack test, where deleting this file and its route must leave the Agent untouched.
> 
> ## Compatibility constraints
> OTLP/JSON field names follow the OpenTelemetry protocol JSON mapping, where 64-bit values arrive as strings; the adapter must parse nanosecond timestamps from strings rather than assuming numbers. The derived `packet_id` is durable stored data, so the derivation inputs and the truncation length are frozen once packets exist. The produced packet must validate against the frozen schema, so a schema bump requires revisiting this adapter.
> 
> ## Ordered steps
> 1. Record `fixtures/otlp/checkout-metrics.json` as a realistic single-service OTLP/JSON metrics export with a request counter and a duration histogram.
> 2. Write `src/ingress/otlp.ts` with the body type, the resource-attribute extraction, and the environment mapping.
> 3. Implement window extraction from the nanosecond string timestamps.
> 4. Implement the error-rate and p95 derivations from the counter and the histogram buckets.
> 5. Implement the required-baselines check and the `AdapterError` returns.
> 6. Implement the deterministic packet id derivation with Web Crypto SHA-256.
> 7. Add the `POST /ingest/otlp` route reusing verification, size limits, and the Agent-forwarding helper.
> 8. Write `test/otlp-adapter.test.ts` asserting the fixture translates to a packet that passes `validatePacket`, that a missing baselines block returns the named adapter error, that an unknown environment is refused, that the packet id is stable across two identical translations, and that the route path works end to end with a valid signature.
> 9. Assert that no file under `src/agent/` imports the adapter.
> 10. Run the adapter test file and the typecheck.
> 
> ## Dependencies
> Depends on the ingress route task for verification and forwarding, on the packet schema task for the target contract, and on the fixtures task for the validation habit. Consumers: the channel portability document cites this file as the deletable channel-specific code, and the README documents the OTLP path as optional.
> 
> ## Edge cases
> - Nanosecond timestamps arriving as JSON strings must be parsed without precision loss into millisecond ISO strings.
> - A histogram with no recorded counts must yield an adapter error rather than a p95 of 0.
> - A resource with no `service.name` attribute is an adapter error naming the attribute.
> - An export carrying multiple services must be refused with a clear error in the MVP rather than silently using the first, because one packet describes one service.
> - Cumulative rather than delta temporality changes the meaning of the counter; the adapter must check the temporality field and refuse an unsupported one.
> - A baselines block present but carrying a non-finite number must be refused by the same validation path as the packet itself.
> 
> ## Plan-gap guidance
> If the producer repository emits OTLP protobuf rather than JSON, or emits a signal this adapter does not read, stop, record `PLAN-GAP` naming the observed encoding and signal, keep the JSON adapter and its route in place, and route to planning. Do not add a protobuf decoding dependency on the spot: it changes the bundle size and the dependency review surface of a public submission repository, which is a decision for planning rather than an implementation detail.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The recorded OTLP fixture translates into a packet that passes the packet validator unchanged.
> - AC-2 (proves-new): A missing baselines block, an unknown environment, a missing service name, and a multi-service export are each refused with a named adapter error rather than a guessed packet.
> - AC-3 (proves-new): Translating the same export twice yields the same deterministic packet id, so a collector retry deduplicates through the existing packet-id path.
> - AC-4 (proves-new): No module under the Agent directory imports the OTLP adapter, preserving the drop-into-Slack property.
> - AC-5 (guards-existing): The signed ingress route tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/otlp-adapter.test.ts -t translates`
> - AC-2: `npx vitest run test/otlp-adapter.test.ts -t refuses`
> - AC-3: `npx vitest run test/otlp-adapter.test.ts -t deterministic`
> - AC-4: `bash -c '! grep -rn "ingress/otlp" src/agent src/workflow'`
> - AC-5: `npx vitest run test/ingest.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/otlp-adapter.test.ts`

## otel-judge-j74

**Epic: Evaluate AgentWorkflow — summarize, Jev, Llama, progress, completion** (epic, closed)

### Description

> Build the durable evaluate pipeline the Agent starts per accepted packet (PRD FR2, FR4, FR6): TypeScript summarization with deltas and baselines computed in code, the Workers AI Llama judge that receives full distributions as priors, durable retried steps, mergeAgentState progress milestones, completion persistence, and the callable history API. Outcome: a fixture packet goes end to end and a connected client sees stage updates while it runs.

## otel-judge-j74.1

**Build the summarize step with code-computed deltas and a hard size cap** (task, closed)

### Description

> ## Objective
> Build the summarize step that turns a validated packet into a compact, size-capped state object with all deltas and baselines computed in TypeScript.
> 
> ## Behavioral context
> Before: the full packet would be the only thing available to send to System One. After: a deterministic function produces a small summary carrying precomputed deltas, a saturation peak, deploy recency, and the top error-bearing spans, and it refuses to emit anything over the size cap, so no raw telemetry tree can reach the model.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The summary type, the delta and baseline arithmetic, the size-cap reduction ladder, and bounded tests driven by the committed fixtures.
> 
> ## Non-goals
> No model calls, no workflow wiring, no persistence. No statistical anomaly detection: deltas are arithmetic, not inference.
> 
> ## Concrete locations
> Create `src/workflow/summarize.ts` (exports `PacketSummary`, `MAX_SUMMARY_BYTES`, `summarizePacket(packet)`, `pctDelta(current, baseline)`). Reads `Packet` from `src/packet/types.ts` and fixtures via `loadFixture()` from `test/fixtures.test.ts`. Add `test/summarize.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); this is a new file.
> 
> ## Resolved decisions
> - `PacketSummary` fields: `packet_id`, `service`, `env`, `window_minutes`, `error_rate`, `error_rate_baseline`, `error_rate_delta_pct`, `p95_latency_ms`, `p95_latency_baseline_ms`, `p95_latency_delta_pct`, `request_rate_rps`, `slo_burn_rate`, `saturation_peak_pct`, `queue_depth`, `deploy_minutes_ago`, `deploy_version`, `top_error_spans`, `alert_labels`, `log_digest`, `baseline_missing`.
> - Deltas are computed in code, never by the model. `pctDelta(current, baseline)` returns `((current - baseline) / baseline) * 100` rounded to one decimal, and returns null when the baseline is 0 or the value is non-finite; any null delta sets `baseline_missing: true` so the judge knows the comparison was unavailable rather than zero.
> - `top_error_spans` is the top 3 spans by `error_count`, each reduced to `{name, count, error_count, error_share}` where error_share is error_count divided by the packet-wide error count, rounded to two decimals. Spans with zero errors are excluded even if they are high-volume.
> - `exemplar_trace_ids` are deliberately not sent to System One. Opaque identifiers carry no signal for a probabilistic judge and consume budget; they remain in SQL for humans to pivot on.
> - `log_digest` is the first two log snippets, each truncated to 200 characters, joined by a newline. Absent snippets produce an empty string, not a null, so the field is always present.
> - `saturation_peak_pct` is the maximum of the cpu and memory percentages when present, otherwise null; `queue_depth` passes through unchanged.
> - `MAX_SUMMARY_BYTES` is 4096, measured on the UTF-8 encoded JSON. When over cap, reduce in this fixed order: drop `log_digest`, then reduce `top_error_spans` to one entry, then drop `alert_labels` beyond the first five. If still over cap, throw a typed `SummaryTooLargeError` rather than truncating mid-structure, because a truncated JSON state would be silently misread by the model.
> - `summarizePacket` is pure and deterministic: same packet in, byte-identical summary out. This is what makes the workflow step safe to retry and the tests exact.
> 
> ## Compatibility constraints
> The summary is the `state` field of the System One request, so its field names are part of what the model was calibrated against; renaming a field changes model behavior and requires re-examining the questions map. It is also persisted indirectly through the judge prompt record, so it must stay JSON-safe. Rounding is fixed so replayed packets produce identical summaries.
> 
> ## Ordered steps
> 1. Write `pctDelta` with the documented null behavior for zero and non-finite baselines.
> 2. Write the `PacketSummary` interface and `MAX_SUMMARY_BYTES`.
> 3. Implement `summarizePacket` computing window minutes, the two deltas, the saturation peak, deploy recency, the top error spans, and the log digest.
> 4. Implement the reduction ladder and the typed oversize error.
> 5. Write `test/summarize.test.ts` asserting the deploy-regression fixture produces the expected deltas, that a zero baseline yields a null delta with the missing flag set, that trace ids never appear in the output, that the output stays under the cap, and that two runs over the same fixture are byte-identical.
> 6. Add a test that an artificially inflated packet triggers the ladder and then the typed error.
> 7. Run the summarize test file and the typecheck.
> 
> ## Dependencies
> Depends on the packet schema task for the `Packet` type and on the fixtures task for the test inputs. Consumers: the request builder receives this summary as `state`, the Llama judge task embeds it in the prompt, and the workflow orchestration task calls it as its first step.
> 
> ## Edge cases
> - A baseline of exactly 0 with a positive current value is the common cold-start case and must yield a null delta rather than Infinity.
> - An empty `top_spans` array yields an empty `top_error_spans` array, not an error.
> - A packet-wide error count of zero must not divide by zero when computing error share.
> - A window whose duration rounds below one minute must report a fractional or minimum value rather than 0, so the judge does not see a zero-length window.
> - Unicode in span names or log snippets must be truncated on code-point boundaries so the JSON stays valid and the byte count stays honest.
> - A packet with no `recent_deploy` yields null deploy fields, which the judge must read as absence rather than as a zero-minute-old deploy.
> 
> ## Plan-gap guidance
> If the 4096-byte cap cannot hold a realistic production packet even after the full reduction ladder, stop, record `PLAN-GAP` naming the fixture, the post-ladder size, and which field dominates, keep the cap and the typed error in place, and route to planning. Do not raise the cap or truncate mid-structure on the spot: the cap exists to keep raw telemetry out of the model, and a unilateral raise would reopen exactly the failure mode the PRD forbids.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The deploy-regression fixture summarises to the documented deltas, saturation peak, deploy recency, and top error spans.
> - AC-2 (proves-new): A zero baseline yields a null delta with the baseline-missing flag set rather than an infinite or zero value.
> - AC-3 (proves-new): The summary never contains exemplar trace ids, stays within the byte cap after the reduction ladder, and raises the typed error instead of truncating when the ladder is exhausted.
> - AC-4 (guards-existing): The fixture validation tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/summarize.test.ts -t deltas`
> - AC-2: `npx vitest run test/summarize.test.ts -t baseline`
> - AC-3: `npx vitest run test/summarize.test.ts -t cap`
> - AC-4: `npx vitest run test/fixtures.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/summarize.test.ts`

## otel-judge-j74.2

**Implement the Workers AI Llama judge with full distributions as priors** (task, closed)

### Description

> ## Objective
> Implement the Workers AI Llama judge that reads the compact summary plus the full System One distributions as priors and returns a structured verdict with a critique and a next action.
> 
> ## Behavioral context
> Before: distributions can be obtained but nothing turns them into a human-readable judgement. After: one function calls the pinned Workers AI model with a prompt carrying the full probability vectors, parses a structured verdict out of the reply, records whether the judge disagreed with the priors, and degrades to a raw-text verdict rather than throwing when the model returns unparseable output.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The model pin, the prompt builder, the Workers AI invocation, the verdict type, and the tolerant parser, with bounded tests against a stubbed AI binding.
> 
> ## Non-goals
> No streaming to clients, no retries (the workflow step owns them), no persistence, and no confidence gating of any kind.
> 
> ## Concrete locations
> Create `src/llm/models.ts` (exports `DEFAULT_LLAMA_MODEL`, `llamaModel(env)`), `src/llm/judge.ts` (exports `Verdict`, `buildJudgePrompt(summary, jev)`, `judgeWithLlama(env, summary, jev)`), and `src/llm/parse.ts` (exports `parseVerdict(text)`). Reads `PacketSummary` from `src/workflow/summarize.ts` and `JevResult` from `src/jev/types.ts`. Add `test/judge.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - This resolves the PRD open question on the model pin. `DEFAULT_LLAMA_MODEL` is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, and `llamaModel(env)` prefers the `LLAMA_MODEL` var so re-pinning is a deploy-time var change, not a code change. The README records the pinned id.
> - Invocation is `env.AI.run(model, {messages, max_tokens: [redacted], temperature: 0.2})` with a system message describing the judge role and a user message carrying the summary and the priors. Low temperature because the output is a structured verdict, not prose variety.
> - The prompt hands over the complete per-question probability vectors plus each noul mass, rendered as JSON under a heading naming them System One priors. Argmax labels are never substituted for the vectors. The prompt states explicitly that the priors are advisory, that the judge may disagree, and that a disagreement must be explained in the critique.
> - There are no hard gates. No code path compares a confidence or a needs_human probability against a threshold to decide routing, block a verdict, or demand a human. Confidence is narrated, never enforced (PRD normative).
> - `Verdict` is `{severity, confidence_note, summary, critique, next_action, disagrees_with_prior}` where severity is one of the four severity choices or `unknown`.
> - `parseVerdict` extracts the first balanced JSON object from the reply, tolerating a fenced code block and leading prose. On any parse failure it returns `{severity: "unknown", summary: "", critique: "", next_action: "", confidence_note: "", disagrees_with_prior: false}` with the raw text attached, and never throws — an unparseable judge must degrade, not fail the packet.
> - When System One is unavailable, the prompt states that no priors are available and why, and asks the judge to proceed from the summary alone. No placeholder distribution is rendered.
> - The prompt and the raw reply are stored in `verdicts.raw_json` so the reasoning trail survives, but neither is broadcast in live state.
> 
> ## Compatibility constraints
> Requires the `AI` binding from the scaffold task and a Workers AI account entitlement for the pinned model. The verdict JSON shape is durable stored history rendered by the demo channel; fields may be added but not renamed. The prompt must stay well inside the model context after the 4096-byte summary cap, so the priors block is the only other large element.
> 
> ## Ordered steps
> 1. Write `src/llm/models.ts` with the default pin and the var-preference rule.
> 2. Write `src/llm/judge.ts` with the `Verdict` interface and `buildJudgePrompt`, rendering the summary, the full priors block or the unavailability statement, and the required output shape.
> 3. State the advisory-priors and no-gating instructions explicitly in the system message.
> 4. Implement `judgeWithLlama` calling the AI binding and passing the reply to `parseVerdict`.
> 5. Write `src/llm/parse.ts` with balanced-brace extraction, code-fence tolerance, and the documented fallback verdict.
> 6. Write `test/judge.test.ts` with a stubbed AI binding covering a clean JSON reply, a fenced reply, a prose-wrapped reply, an unparseable reply, and the System One unavailable prompt path.
> 7. Assert that the built prompt contains every outcome probability from the priors and does not contain an argmax-only rendering.
> 8. Assert that no code path compares a probability against a threshold.
> 9. Run the judge test file and the typecheck.
> 
> ## Dependencies
> Depends on the summarize task for `PacketSummary` and on the System One client task for `JevResult`. Consumers: the workflow orchestration task calls `judgeWithLlama` as its final step, the completion task persists the verdict, and the callable history task returns it.
> 
> ## Edge cases
> - A reply containing two JSON objects must use the first balanced one, not a greedy match to the last closing brace.
> - A reply with a severity string outside the four choices must be normalised to `unknown` rather than stored verbatim as a severity.
> - An AI binding call that rejects must propagate so the workflow step can retry it; only parse failures degrade.
> - A priors block where one question is missing (partial System One success is impossible by the parser contract, but defensive) must render the present questions and note the absent one.
> - Very long critique text must be stored in full in SQL but must not be copied into live state.
> - The unavailability path must not leave the literal word undefined in the prompt.
> 
> ## Plan-gap guidance
> If the pinned Workers AI model is unavailable on the account, stop, record `PLAN-GAP` naming the model id and the binding error, keep the prompt builder and parser in place, and route to planning. Do not silently swap in a different model family: the model id is a documented README claim and part of the Cloudflare assignment mapping, and a substitution changes the verdict quality the acceptance fixtures were written against.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The built prompt renders every outcome probability and noul mass from the System One priors rather than an argmax label.
> - AC-2 (proves-new): A clean JSON reply, a fenced reply, and a prose-wrapped reply all parse into the structured verdict, and an unparseable reply degrades to an unknown-severity verdict carrying the raw text instead of throwing.
> - AC-3 (proves-new): With System One unavailable, the prompt states the absence and asks the judge to proceed, rendering no placeholder distribution.
> - AC-4 (proves-new): No source file under the judge path compares a confidence or needs-human probability against a numeric threshold.
> - AC-5 (guards-existing): The summarize tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/judge.test.ts -t priors`
> - AC-2: `npx vitest run test/judge.test.ts -t parse`
> - AC-3: `npx vitest run test/judge.test.ts -t unavailable`
> - AC-4: `bash -c '! grep -rEn "(confidence|needs_human)[a-z_.\[\]\" ]*[<>]=?[ ]*[0-9]" src/llm src/workflow'`
> - AC-5: `npx vitest run test/summarize.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/judge.test.ts`

## otel-judge-j74.3

**Orchestrate the Evaluate AgentWorkflow with durable retried steps** (task, closed)

### Description

> ## Objective
> Wire the three evaluate stages into one durable AgentWorkflow whose orchestration logic is a pure, injectable function with per-step retry policies.
> 
> ## Behavioral context
> Before: summarize, System One, and the judge exist as independent functions that nothing calls in sequence. After: one workflow runs them in order with durable retries, a System One failure logs and continues to the judge instead of aborting the packet, and the orchestration can be exercised in tests with a fake step object without starting a real workflow.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The pure orchestration function, its dependency bag, the workflow entrypoint adapter that binds real dependencies, the per-step retry configuration, and bounded tests using a fake step.
> 
> ## Non-goals
> No state broadcasting and no completion persistence — those are the next task. No Agent-side start call, which the same next task installs. No new model or API behavior.
> 
> ## Concrete locations
> Create `src/workflow/evaluate.ts` (exports `EvaluatePayload`, `EvaluateResult`, `EvaluateDeps`, `runEvaluate(step, payload, deps)`, `STEP_RETRIES`). Rewrite `src/workflow/EvaluateWorkflow.ts` (exports `class EvaluateWorkflow extends AgentWorkflow` with `run(event, step)`). Uses `summarizePacket()`, `callSystemOne()`, and `judgeWithLlama()`. Add `test/evaluate.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `EvaluateWorkflow.ts` is the scaffold placeholder.
> 
> ## Resolved decisions
> - The orchestration lives in the pure function `runEvaluate(step, payload, deps)`, where `deps` is `{summarize, callSystemOne, judge, onProgress}`. `EvaluateWorkflow.run` is a thin adapter that binds the real implementations and calls it. Rationale: a workflow class body is awkward to test and the Workers test pool offers no first-class workflow harness, so all branching logic must sit where a fake step can drive it. Do not move logic into the class body.
> - Three steps with distinct policies in `STEP_RETRIES`: `summarize` runs with no retries because it is pure and deterministic, so a failure is a code defect that retrying cannot fix; `jev` retries with limit 2, delay 1 second, exponential backoff; `judge` retries with limit 2, delay 2 seconds, exponential backoff. Retry ownership sits here and nowhere else — the System One client performs exactly one attempt per call by design.
> - The `jev` step never fails the workflow. A non-retryable failure or an exhausted retry budget resolves to the typed failure result, and the `judge` step still runs. This is the PRD rule to log and continue and still attempt the judge with available state.
> - A `judge` step failure after its retries does fail the workflow; the completion task records that failure and moves live state to `failed`.
> - `EvaluateResult` is `{packet_id, summary, jev, verdict, failed_at?}` so the completion task has everything it needs in one value and does not re-derive anything.
> - `onProgress` is called between steps with a small milestone object. In this task it is part of the dependency bag and is invoked, but the Agent-side implementation that merges state arrives in the next task; the default dependency is a no-op so the workflow is runnable in isolation.
> - The payload carries the validated packet, not a packet id alone, so a step retry does not depend on the Agent still holding the row.
> 
> ## Compatibility constraints
> Requires the `EVALUATE_WORKFLOW` binding and the `AgentWorkflow` base class from the agents package. Step names are recorded in Workflow history and are used to read run traces, so renaming a step loses the trail for in-flight runs. Payloads must be JSON-serialisable because the workflow engine persists them between steps.
> 
> ## Ordered steps
> 1. Write `src/workflow/evaluate.ts` with the payload, result, and dependency types plus `STEP_RETRIES`.
> 2. Implement `runEvaluate` calling `step.do("summarize", ...)`, then `step.do("jev", retryConfig, ...)`, then `step.do("judge", retryConfig, ...)`.
> 3. Implement the log-and-continue branch so a failed `jev` step resolves rather than rejects.
> 4. Call `onProgress` after each step with the documented milestone shape.
> 5. Rewrite `src/workflow/EvaluateWorkflow.ts` as an adapter binding the real dependencies and returning the `EvaluateResult`.
> 6. Write `test/evaluate.test.ts` with a fake step that records step names and retry configs, covering the happy path, a System One failure still reaching the judge, a judge failure surfacing as a workflow failure, and the exact retry policy per step.
> 7. Assert step ordering and that summarize is configured with no retries.
> 8. Run the evaluate test file and the typecheck.
> 
> ## Dependencies
> Depends on the summarize task, the System One client task, the degraded-mode task, and the judge task for the three step implementations. Consumers: the progress and completion task binds the real `onProgress` and persists the result, and the Agent accept path starts this workflow through its seam.
> 
> ## Edge cases
> - A summarize failure must fail fast with the typed oversize error rather than retrying a deterministic error two more times.
> - A System One step that throws rather than returning a typed failure must be caught and normalised to a failure result, so the judge still runs.
> - The judge step must receive the System One failure reason, not an empty object, so its prompt can state the cause.
> - Duplicate workflow instances for the same packet id (a retried start) must be safe because every step is idempotent and completion upserts.
> - A fake step in tests must be able to simulate retry exhaustion without real delays.
> 
> ## Plan-gap guidance
> If the installed agents package does not export `AgentWorkflow` or its step API has no per-step retry configuration, stop, record `PLAN-GAP` naming the installed version and the actual workflow surface, keep `runEvaluate` and its tests in place since they are runtime-independent, and route to planning. Do not collapse the pipeline into a synchronous call inside onRequest: the PRD explicitly forbids a single giant synchronous onRequest body, and FR2 requires durable retried steps.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The happy path runs summarize, then System One, then the judge, in that order, and returns a result carrying all three outputs.
> - AC-2 (proves-new): A System One failure, retryable or not, still reaches the judge step and resolves the workflow rather than aborting it.
> - AC-3 (proves-new): A judge failure after its retries fails the workflow, and the summarize step is configured with no retries while the other two carry the documented limits and backoff.
> - AC-4 (guards-existing): The judge tests and the System One degraded tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/evaluate.test.ts -t "happy path"`
> - AC-2: `npx vitest run test/evaluate.test.ts -t "continue"`
> - AC-3: `npx vitest run test/evaluate.test.ts -t retries`
> - AC-4: `npx vitest run test/judge.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/evaluate.test.ts`

## otel-judge-j74.4

**Broadcast workflow progress and persist completed evaluations** (task, closed)

### Description

> ## Objective
> Broadcast workflow progress to connected clients through mergeAgentState and persist the completed evaluation to SQL, replacing the accept-path evaluation seam with a real workflow start.
> 
> ## Behavioral context
> Before: the workflow can run but nothing starts it from the Agent, no client sees it progress, and its result is discarded. After: accepting a packet starts the durable workflow, a connected client observes the stage move through summarized, jev, judging, and complete without polling, and on completion the System One run, its answers, and the Llama verdict are written to SQL while live state keeps only the small snapshot.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The `startEvaluate` implementation, the progress milestones merged into Agent state, the completion handler, the SQL write pass, and bounded tests that watch state transitions and inspect the stored rows.
> 
> ## Non-goals
> No new evaluation logic and no changes to the step retry policy. No WebSocket protocol beyond what state broadcast already provides. No history read API, which is the next task.
> 
> ## Concrete locations
> Edit `src/agent/OtelJudgeAgent.ts` to implement `startEvaluate(packet)` and `onWorkflowComplete(event)`. Edit `src/workflow/EvaluateWorkflow.ts` to bind `onProgress` to `mergeAgentState`. Create `src/agent/persist.ts` (exports `persistEvaluation(sql, result)`). Uses `recordJevRun()`, `recordJevAnswers()`, `recordVerdict()` from `src/agent/store.ts` and `toJevRunRow()` from `src/jev/degraded.ts`. Add `test/progress.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `startEvaluate` is the designated no-op seam from the accept-path task.
> 
> ## Resolved decisions
> - `startEvaluate(packet)` calls `this.runWorkflow(EvaluateWorkflow, {packet_id, packet, agent_name})` and returns without awaiting completion, preserving the fast acknowledgement contract.
> - Milestones merged into state, in order: `{stage: "summarized"}` after summarize, `{stage: "jev", jev_status}` after System One, `{stage: "judging"}` before the judge, and on completion either `{stage: "complete", last_verdict: {severity, summary}}` or `{stage: "failed"}`. Every merge refreshes `updated_at`.
> - Only the small snapshot is merged. Full distributions, prompts, and critique text never enter live state, because state is broadcast to every connected client and the demo origin is public (NFR1).
> - `onWorkflowComplete` performs one persistence pass in `persistEvaluation`: upsert the `jev_runs` row from the result, insert the `jev_answers` rows with full vectors when the run succeeded, upsert the `verdicts` row, and update `packets.status` to complete or failed. Upserts make a workflow replay safe.
> - Persistence happens on completion rather than per step, so a retried step cannot leave a half-written history; the only per-step write is the state merge, which is deliberately disposable.
> - A failed workflow still writes the `jev_runs` row and updates `packets.status` to failed, so history shows the attempt rather than a gap.
> - `mergeAgentState` is used rather than `setState` for milestones so concurrent packets on the same Agent do not clobber each other.
> 
> ## Compatibility constraints
> The stage vocabulary is a published contract consumed by the demo channel, so stages may be added but not renamed. Requires the `EVALUATE_WORKFLOW` binding and the workflow completion callback from the agents package. All SQL writes target the tables frozen by the storage task.
> 
> ## Ordered steps
> 1. Implement `startEvaluate` in `src/agent/OtelJudgeAgent.ts` to start the workflow without awaiting it, replacing the logged no-op seam.
> 2. Bind `onProgress` in the `EvaluateWorkflow` adapter to a merge into the owning Agent state.
> 3. Emit the four documented milestones at their stage boundaries.
> 4. Write `src/agent/persist.ts` with `persistEvaluation` performing the upsert pass in one function.
> 5. Implement `onWorkflowComplete` to call `persistEvaluation` and then set the terminal state.
> 6. Handle the failure branch, writing the run row and the failed status.
> 7. Write `test/progress.test.ts` accepting a fixture packet, collecting observed state transitions, and asserting the stage order, that no distribution or prompt text appears in any observed state, and that after completion the answers and verdict rows exist with full vectors.
> 8. Add a test for the failure branch asserting the failed stage and the stored attempt.
> 9. Run the progress test file and the typecheck.
> 
> ## Dependencies
> Depends on the workflow orchestration task for `runEvaluate` and the result shape, on the accept-path task for the `startEvaluate` seam, and on the storage task for the write helpers. Consumers: the callable history task reads the rows written here, and the README and demo channel document the stage vocabulary.
> 
> ## Edge cases
> - A workflow completing after the Agent has been evicted must still persist on rehydration; the completion handler must not assume in-memory context from the accept call.
> - Two packets evaluated concurrently on one Agent must not overwrite each other, which is why merges are partial rather than whole-state sets.
> - A completion event for a packet id not present in `packets` must be recorded as an error rather than inserting a phantom row.
> - A System One failure result must still produce exactly one run row and zero answer rows.
> - Replayed completion for an already-complete packet must be idempotent, leaving one verdict row.
> - The terminal state must be set after persistence, so a client that reacts to the complete stage by querying history finds the rows present.
> 
> ## Plan-gap guidance
> If the installed agents package provides no completion callback for a workflow started by an Agent, stop, record `PLAN-GAP` naming the installed version and the lifecycle hooks it does provide, keep the milestone merges in place, and route to planning. Do not poll workflow status from the Agent on a timer: polling changes the durability story the PRD relies on and would keep the Durable Object awake indefinitely.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): Accepting a fixture packet drives observed live state through summarized, jev, judging, and complete in that order without any client polling.
> - AC-2 (proves-new): No observed state snapshot contains a probability distribution, a prompt, or critique text.
> - AC-3 (proves-new): After completion, the System One run row, the answer rows with full vectors, and the verdict row all exist, and replaying completion leaves exactly one verdict row.
> - AC-4 (proves-new): A judge failure moves live state to failed and still records the attempt in history.
> - AC-5 (guards-existing): The accept-path tests and the orchestration tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/progress.test.ts -t stages`
> - AC-2: `npx vitest run test/progress.test.ts -t "state stays small"`
> - AC-3: `npx vitest run test/progress.test.ts -t persisted`
> - AC-4: `npx vitest run test/progress.test.ts -t failure`
> - AC-5: `npx vitest run test/accept.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/progress.test.ts`

## otel-judge-j74.5

**Expose callable history and human-label API over the SQL store** (task, closed)

### Description

> ## Objective
> Expose the stored evaluation history and the human-label write path as callable Agent methods, so any channel can read history without a bespoke HTTP surface.
> 
> ## Behavioral context
> Before: SQL history exists but is only reachable from inside the Agent, so the PRD acceptance item about querying history has no documented path. After: a connected client can list recent packets with their verdict severity, fetch one packet with its full distributions and verdict, and attach a human label — all through the Agents SDK callable mechanism that the demo channel already speaks.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> Three callable methods, their argument validation, their return shapes, and bounded tests exercising them against a populated Agent.
> 
> ## Non-goals
> No pagination cursors beyond a limit, no full-text search, no export endpoint, and no authentication — the Worker door owns request verification.
> 
> ## Concrete locations
> Edit `src/agent/OtelJudgeAgent.ts` to add `getHistory(limit)`, `getPacket(packetId)`, and `labelPacket(packetId, label, note)`, each decorated with the Agents SDK callable decorator. Create `src/agent/api-types.ts` (exports `HistoryRow`, `PacketDetail`, `HUMAN_LABELS`). Uses `listRecentPackets()`, `getPacketRecord()`, `recordHumanLabel()` from `src/agent/store.ts`. Add `test/history-api.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); the store helpers come from the storage task.
> 
> ## Resolved decisions
> - `getHistory(limit = 20)` returns newest-first `HistoryRow` objects `{packet_id, service, env, window_start, window_end, received_at, status, severity}` where severity comes from the joined verdict or null when the packet has not completed. The limit is clamped to the range 1 to 100 so a client cannot pull the whole table in one call.
> - `getPacket(packetId)` returns `PacketDetail` `{packet, jev_run, jev_answers, verdict, labels}` with every answer carrying its complete probability vector and noul mass. It returns null for an unknown id rather than throwing, so a channel renders an empty state instead of an error.
> - `labelPacket(packetId, label, note)` is the single human-label write path for every channel. `label` must be one of `sev0`, `sev1`, `sev2`, `noise`, `wrong`; anything else is rejected with a typed error. `note` is optional and capped at 500 characters. It returns the stored row.
> - `wrong` is included as a label because the most valuable human signal is disagreement with the judge, and forcing that into a severity bucket would lose it.
> - These callable methods are the documented API that satisfies the PRD acceptance item "SQL retains history"; the README documents their names, arguments, and return shapes.
> - Labelling a packet does not re-run evaluation and does not alter the verdict. Human labels are a parallel record, not a correction, so replayed history stays auditable.
> - Reads never touch live state, so a history query cannot perturb what other connected clients see.
> 
> ## Compatibility constraints
> The callable method names and their return shapes are the contract the demo repository codes against; renaming a method or a returned field breaks it. The label vocabulary is durable stored data. Requires the callable mechanism from the agents package and a client that speaks it.
> 
> ## Ordered steps
> 1. Write `src/agent/api-types.ts` with `HistoryRow`, `PacketDetail`, and the frozen `HUMAN_LABELS` tuple.
> 2. Add `getHistory` to the Agent, clamping the limit and mapping store rows to `HistoryRow`.
> 3. Add `getPacket`, assembling the detail from the store record and parsing every answer JSON back into a distribution.
> 4. Add `labelPacket` with label and note validation and the store write.
> 5. Decorate all three with the callable decorator and confirm they are reachable from a client stub in the Workers pool.
> 6. Write `test/history-api.test.ts` populating an Agent with two packets, asserting newest-first ordering, limit clamping at both ends, full-vector round trip in the detail, a null return for an unknown id, label acceptance and rejection, and that a label leaves the verdict unchanged.
> 7. Run the history API test file and the typecheck.
> 
> ## Dependencies
> Depends on the storage task for the read helpers and on the progress and completion task for rows worth reading. Consumers: the demo repository calls these methods, the README documents them, and the channel portability document cites them as the channel-agnostic surface.
> 
> ## Edge cases
> - A limit of 0, a negative limit, or a limit above 100 must clamp rather than error.
> - A packet whose evaluation failed must appear in history with a null severity and a failed status, not be hidden.
> - A corrupt stored answer JSON must degrade that one answer rather than failing the whole detail read.
> - Two labels on the same packet both persist; the API returns them in insertion order rather than collapsing them.
> - A note over the cap is rejected rather than truncated, so the writer learns about it.
> - `getPacket` on a packet accepted but not yet evaluated returns the packet with null run, empty answers, and null verdict.
> 
> ## Plan-gap guidance
> If the installed agents package exposes no callable mechanism, stop, record `PLAN-GAP` naming the installed version and the client-facing surface it does provide, keep the store-backed read functions in place, and route to planning. Do not add a bespoke HTTP history route on the Agent as a substitute without that decision: the PRD acceptance item allows a documented API, but choosing one changes what the demo repository must implement and is a cross-repository decision.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): History returns newest-first rows with joined verdict severity, and the limit clamps at both the low and high ends.
> - AC-2 (proves-new): Packet detail returns the full probability vector and noul mass for every question, and returns null for an unknown packet id.
> - AC-3 (proves-new): A valid human label persists and returns the stored row, an invalid label is rejected, and labelling leaves the verdict unchanged.
> - AC-4 (guards-existing): The progress and completion tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/history-api.test.ts -t history`
> - AC-2: `npx vitest run test/history-api.test.ts -t detail`
> - AC-3: `npx vitest run test/history-api.test.ts -t label`
> - AC-4: `npx vitest run test/progress.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/history-api.test.ts`

## otel-judge-smu

**Epic: Jev System One client and questions map** (epic, closed)

### Description

> Implement the System One half of the diamond model (PRD FR6): the five-question atomic batch, the plain-fetch client against the TypeSafe systemone endpoint with Bearer [redacted] and no streaming, full probability-vector parsing including noul mass, and the degraded path when the key is missing or the service fails. Outcome: the workflow can obtain full distributions, or a typed unavailability result, and never fabricates priors.

## otel-judge-smu.1

**Encode the System One questions map and atomic request builder** (task, closed)

### Description

> ## Objective
> Encode the normative MVP questions map and build the single atomic System One request body from a compact packet summary.
> 
> ## Behavioral context
> Before: nothing in the codebase names the questions the Agent asks System One. After: the five questions from the PRD exist as typed, exported constants with their outcome sets, and one builder produces a single batched request body carrying all five questions and the compact state, so the Agent makes one call per packet rather than five.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The questions map constant, its types, the model-id selection rule, and the request-body builder plus bounded tests.
> 
> ## Non-goals
> No HTTP transport, no auth, no retries, no response parsing — those belong to the client task. No changes to the question set beyond the PRD MVP list.
> 
> ## Concrete locations
> Create `src/jev/questions.ts` (exports `QUESTIONS`, `QuestionKey`, `SystemOneQuestion`, `SEVERITY_CHOICES`, `ROOT_CAUSE_CHOICES`) and `src/jev/request.ts` (exports `jevModel(env)`, `buildSystemOneRequest(state, env)`, `SystemOneRequestBody`). Add `test/jev-questions.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - The MVP questions map is exactly the PRD table, frozen in this order:
>   `severity` — choice over `sev0`, `sev1`, `sev2`, `noise`;
>   `needs_human` — noul, criteria "Would an SRE want eyes on this now?";
>   `deploy_related` — noul, criteria "Is this incident related to a recent deploy?";
>   `noise_likely` — noul, criteria "Is this alert most likely noise rather than a real incident?";
>   `root_cause_family` — choice over `deploy_regression`, `dependency`, `saturation`, `bad_config`, `unknown`.
> - All five are sent in one request. The PRD states the answers are independent, which is what makes atomic batching safe; a per-question request loop would multiply latency and cost with no accuracy gain.
> - The request body is `{model, state, questions: [...]}` where `state` is the compact packet summary produced by the summarize step, not the raw packet and never a raw OpenTelemetry tree.
> - Model selection: `jevModel(env)` returns `env.JEV_MODEL` when set, otherwise the default `jev-latest`. The README records that the pin moves to `jev-1.13.0` once the questions stabilise, and pinning is then a var change rather than a code change.
> - Streaming is never requested; no `stream` field is emitted at all.
> - `QuestionKey` is a string union derived from the map so every downstream switch over question keys is exhaustively checked by the compiler.
> - Question text is stored alongside each key so the stored history explains what was asked, not just what was answered.
> 
> ## Compatibility constraints
> The question keys are durable identifiers written into the `jev_answers.question_key` column and rendered by the demo channel; adding a question is additive, but renaming or removing one strands stored history. The request body must match the TypeSafe System One API shape for `POST /v1/systemone`. No Node SDK is used, so the body must be plain JSON serialisable.
> 
> ## Ordered steps
> 1. Write `src/jev/questions.ts` with the `SystemOneQuestion` interface (key, type, text, choices for choice questions) and the frozen `QUESTIONS` array.
> 2. Derive `QuestionKey` from the array with a const assertion so the union stays in sync automatically.
> 3. Write `src/jev/request.ts` with `jevModel(env)` implementing the var-then-default rule.
> 4. Implement `buildSystemOneRequest(state, env)` returning the body with model, state, and all five questions, omitting any streaming field.
> 5. Write `test/jev-questions.test.ts` asserting the five keys and their order, the two choice sets, that the built body contains all five questions and the provided state, that no streaming field is present, and that the model falls back to the default when the var is unset.
> 6. Run the questions test file and the typecheck.
> 
> ## Dependencies
> Depends on the packet schema task only for the summary type shape it accepts (structural, not an import cycle). Consumers: the System One client task posts this body, the storage task stores answers keyed by these question keys, and the Llama judge task reads the same keys when presenting priors.
> 
> ## Edge cases
> - A `state` object that exceeds the summarize step size cap must not be silently sent; the builder rejects a state whose serialised size exceeds the cap with a typed error, so oversize payloads fail here rather than at the API.
> - An unset `JEV_MODEL` var must not produce the string "undefined" in the request body.
> - A choice question with an empty choices array must fail the build, since System One cannot answer it.
> - Question order must be stable across builds so stored history and replay comparisons line up.
> 
> ## Plan-gap guidance
> If the TypeSafe System One request schema does not accept a batched `questions` array in one call, stop, record `PLAN-GAP` naming the observed API shape and the error, keep the questions map in place, and route to planning. Do not silently fan out to five sequential requests: the PRD specifies batching, and a fan-out changes the latency and cost profile the workflow retry policy was sized against.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): The exported questions map contains exactly the five normative keys in the frozen order with the documented choice sets.
> - AC-2 (proves-new): One built request body carries all five questions plus the supplied compact state and contains no streaming field.
> - AC-3 (proves-new): The model id comes from the environment var when set and falls back to the documented default when it is not.
> - AC-4 (guards-existing): The packet validator tests still pass.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/jev-questions.test.ts -t "questions map"`
> - AC-2: `npx vitest run test/jev-questions.test.ts -t batch`
> - AC-3: `npx vitest run test/jev-questions.test.ts -t model`
> - AC-4: `npx vitest run test/packet-validate.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/jev-questions.test.ts`

## otel-judge-smu.2

**Implement System One fetch client with typed failures and full-distribution parsing** (task, closed)

### Description

> ## Objective
> Implement the System One HTTP client over plain fetch with Bearer [redacted] and a timeout, and parse responses into full probability distributions including noul mass.
> 
> ## Behavioral context
> Before: the request body can be built but nothing sends it. After: one function posts the batched request to the TypeSafe System One endpoint, returns a typed success carrying the complete probability vector for every question, and returns a typed failure that says whether the caller should retry — without retrying internally and without ever throwing.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The fetch transport, auth header, timeout, typed result union, and the response parser that preserves full distributions. Bounded tests use a stubbed global fetch.
> 
> ## Non-goals
> No retries and no backoff — retries are owned by the workflow step so they are durable and observable. No degraded-mode policy, which is the next task. No prose generation: System One returns structured answers only.
> 
> ## Concrete locations
> Create `src/jev/types.ts` (exports `JevDistribution`, `JevAnswer`, `JevSuccess`, `JevFailure`, `JevResult`), `src/jev/client.ts` (exports `SYSTEM_ONE_URL`, `JEV_TIMEOUT_MS`, `callSystemOne(env, state)`), and `src/jev/parse.ts` (exports `parseSystemOneResponse(json)`). Uses `buildSystemOneRequest()` from `src/jev/request.ts`. Add `test/jev-client.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); these are new files.
> 
> ## Resolved decisions
> - Endpoint is `https://api.typesafe.ai/v1/systemone`, method POST, headers `authorization: [redacted] and `content-type: application/json`, sent with the runtime `fetch`. No Node SDK is used, because Workers has no Node HTTP stack.
> - `JEV_TIMEOUT_MS` is 10000, applied with `AbortSignal.timeout(JEV_TIMEOUT_MS)`. A timeout is a retryable failure.
> - The client performs exactly one attempt and never retries. Retry ownership sits in the workflow step, so attempts are durable, visible in the Workflow history, and cannot multiply against a hidden in-client loop. This is a deliberate correction of the otherwise tempting double-retry design.
> - Result union: `{ok: true, answers: JevAnswer[], model, latency_ms}` or `{ok: false, retryable: boolean, reason: string, status?: number}`. Retryable is true for network errors, timeouts, HTTP 429, and HTTP 5xx; false for every other 4xx and for a malformed response body.
> - `JevAnswer` is `{key: QuestionKey, distribution: JevDistribution, noul: number, argmax: {outcome: string, p: number}}` where `JevDistribution` is a record of outcome to probability. The argmax is computed for convenience and stored alongside, never instead of, the vector — PRD requires full distributions to reach System Two (FR6).
> - The parser validates that every requested question key is present, that probabilities are finite numbers, and that the vector plus noul sums to within 0.01 of 1. A violation is a non-retryable malformed-response failure, because retrying a schema mismatch cannot help.
> - Nothing about the response is logged verbatim beyond the model id and latency; answer payloads go to SQL, not to console output, so logs stay free of customer signal detail.
> 
> ## Compatibility constraints
> Workers runtime only: fetch, AbortSignal.timeout, and Web Crypto are available; Node HTTP agents are not. The API key is read from `env.TYPESAFE_API_KEY`, a Wrangler secret, and must never be written to logs, state, or SQL (NFR1). The stored answer JSON shape is durable history consumed by the demo channel.
> 
> ## Ordered steps
> 1. Write `src/jev/types.ts` with the distribution, answer, and result types.
> 2. Write `src/jev/parse.ts` with `parseSystemOneResponse`, checking key coverage, numeric validity, and the probability-mass sum, and computing the argmax.
> 3. Write `src/jev/client.ts` with the endpoint constant, the timeout constant, and `callSystemOne` building the request, posting it, and mapping status codes onto the result union.
> 4. Map every failure path onto `retryable` per the documented rule, including the AbortError from a timeout.
> 5. Write `test/jev-client.test.ts` stubbing `globalThis.fetch` to cover a successful batch, a 500, a 429, a 400, a network rejection, a timeout, and a malformed body whose probabilities do not sum to one.
> 6. Assert in the success test that the full vector survives parsing and that the argmax is additive rather than replacing it.
> 7. Restore the original fetch in an afterEach so stubs do not leak across test files.
> 8. Run the client test file and the typecheck.
> 
> ## Dependencies
> Depends on the questions task for `buildSystemOneRequest` and the question keys. Consumers: the degraded-mode task wraps this client, the workflow orchestration task calls it inside a retried step, and the storage task persists the answers it returns.
> 
> ## Edge cases
> - A 200 response with an HTML or empty body must become a non-retryable malformed failure, not a parse exception.
> - A response missing one of the five question keys is malformed even if the other four are valid.
> - A distribution containing a negative probability or a NaN is malformed.
> - A vector that sums to 1 while noul is also positive exceeds the mass budget and is malformed.
> - An abort from the timeout must be distinguished from a generic network error in the failure reason so the workflow history is diagnosable.
> - The Bearer [redacted] must be omitted entirely rather than sent as `Bearer [redacted]` when the key is absent; the degraded-mode task then short-circuits that case.
> 
> ## Plan-gap guidance
> If the System One response encodes probabilities in a shape the parser cannot map to a per-question vector plus a noul mass — for example only an argmax label is returned — stop, record `PLAN-GAP` naming the observed response shape, keep the client and its typed failures in place, and route to planning. Do not synthesise a distribution from an argmax: handing fabricated priors to System Two violates the normative diamond-model requirement that full distributions reach the judge, and the fabrication would then be stored as history.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): A successful batched call returns every question key with its complete probability vector and noul mass preserved, plus an argmax stored alongside the vector.
> - AC-2 (proves-new): HTTP 429, HTTP 5xx, network rejection, and timeout each return a typed failure flagged retryable, while HTTP 4xx other than 429 returns a failure flagged non-retryable.
> - AC-3 (proves-new): A malformed body whose probability mass does not sum to one returns a non-retryable failure instead of throwing.
> - AC-4 (guards-existing): The questions map tests still pass, proving the request builder contract is unchanged.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/jev-client.test.ts -t distributions`
> - AC-2: `npx vitest run test/jev-client.test.ts -t retryable`
> - AC-3: `npx vitest run test/jev-client.test.ts -t malformed`
> - AC-4: `npx vitest run test/jev-questions.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/jev-client.test.ts`

## otel-judge-smu.3

**Implement System One degraded mode with no fabricated priors** (task, closed)

### Description

> ## Objective
> Define and implement the degraded path for System One so a missing key or a failing service never blocks the judge and never produces fabricated priors.
> 
> ## Behavioral context
> Before: with no TypeSafe key configured the client would attempt a call with a malformed authorization header and fail slowly. After: a missing or empty key short-circuits with no network call at all, every failure is recorded as a first-class unavailable run in history, and the evaluation continues to the Llama judge carrying an explicit unavailability marker rather than any invented distribution.

### Design

> ## Readiness schema
> v1
> 
> ## Scope
> The key-presence short circuit, the unavailability marker type that downstream steps consume, the persistence of an unavailable run, and bounded tests.
> 
> ## Non-goals
> No fixture or synthetic judge path — that option is explicitly rejected below. No changes to retry policy, which the workflow step owns. No user-facing degraded UI, which belongs to the demo repository.
> 
> ## Concrete locations
> Edit `src/jev/client.ts` to add the key short circuit at the top of `callSystemOne`. Create `src/jev/degraded.ts` (exports `JevUnavailable`, `toJevRunRow(result)`, `isJevUsable(env)`). Uses `recordJevRun()` from `src/agent/store.ts`. Add `test/jev-degraded.test.ts`. Evidence: CodeGraph index is empty (greenfield repo); `callSystemOne` comes from the System One client task.
> 
> ## Resolved decisions
> - This resolves the PRD open question "degraded mode when TypeSafe key missing (fixture judge path?)". The answer is no fixture judge. No synthetic, cached, or default distribution is ever produced. Rationale: the PRD makes full distributions normative input to System Two, and a fabricated prior would be indistinguishable from a real one once it reached SQL history and the demo board.
> - When `env.TYPESAFE_API_KEY` is absent, empty, or whitespace, `callSystemOne` returns `{ok: false, retryable: false, reason: "missing_api_key"}` immediately, performing no fetch. `isJevUsable(env)` exposes the same check for callers that want to branch before building a request.
> - Every non-ok result becomes one `jev_runs` row with `status` set to `unavailable` for `missing_api_key` and `error` otherwise, carrying the reason and, when present, the HTTP status. No `jev_answers` rows are written. The separate run table from the storage task is what makes this representable without a fake answer.
> - The evaluation always proceeds to System Two afterwards. The judge receives `jev: {available: false, reason}` and its prompt states that no priors are available, satisfying the PRD rule to log and continue and still attempt the judge with available state.
> - Live state carries `jev_status` as `unavailable` so a connected client can see the degraded run without querying SQL.
> - The reason string is a stable machine token (`missing_api_key`, `timeout`, `http_429`, `http_500`, `malformed_response`, `network_error`), not free prose, so the demo channel can group them.
> 
> ## Compatibility constraints
> `jev_runs.status` and the reason tokens are durable stored values rendered by the demo channel; adding a token is additive, renaming one strands history. The short circuit must not change behavior when the key is present. The API key is never included in any reason, log line, state field, or stored row (NFR1).
> 
> ## Ordered steps
> 1. Add `isJevUsable(env)` and the short circuit at the top of `callSystemOne`, returning before any fetch when the key is missing.
> 2. Write `src/jev/degraded.ts` with the `JevUnavailable` type and `toJevRunRow(result)` mapping every result variant onto a `jev_runs` row shape.
> 3. Normalise every failure reason onto the stable token set.
> 4. Ensure `toJevRunRow` for an ok result produces a `status: "ok"` row with model and latency, so one function covers both paths.
> 5. Write `test/jev-degraded.test.ts` asserting that an unset key performs zero fetch calls, that the returned failure is non-retryable with reason missing_api_key, that each failure variant maps to the documented token, and that no answer rows are produced for a failed run.
> 6. Assert explicitly that no default or synthetic distribution is returned on any degraded path.
> 7. Run the degraded test file and the typecheck.
> 
> ## Dependencies
> Depends on the System One client task for `callSystemOne` and the result union, and on the storage task for the `jev_runs` row shape. Consumers: the workflow orchestration task branches on the result, the Llama judge task renders the unavailability in its prompt, and the workflow completion task persists the run row.
> 
> ## Edge cases
> - A key consisting only of whitespace must be treated as missing, not sent as a Bearer [redacted]
> - A key that is present but rejected with 401 is an `error` run, not an `unavailable` run — the distinction matters for operators reading history.
> - The short circuit must not swallow a genuine configuration mistake silently; it emits one structured log line naming the reason without the key.
> - A degraded run must still advance the stage so a connected client does not appear stuck.
> - Repeated degraded runs for the same packet on workflow retry must upsert the single `jev_runs` row rather than accumulating rows.
> 
> ## Plan-gap guidance
> If a stakeholder requires the demo to show priors even with no TypeSafe key — the fixture judge path this task rejects — stop, record `PLAN-GAP` naming the requester, the requirement, and this resolved decision, keep the no-fabrication behavior in place, and route to planning. Do not add a fixture prior behind a flag: once fabricated vectors can reach SQL, no later reader can distinguish real priors from demo ones.

### Acceptance criteria

> ## Observable criteria
> - AC-1 (proves-new): With no TypeSafe key configured, the client performs zero network calls and returns a non-retryable failure whose reason is the missing-key token.
> - AC-2 (proves-new): Every failure variant maps onto the documented stable reason token and onto a run row with the correct status, with no answer rows written.
> - AC-3 (proves-new): No degraded path returns a synthetic or default probability distribution.
> - AC-4 (guards-existing): The System One client tests still pass, proving the short circuit did not change behavior when a key is present.
> 
> ## Criterion checks
> - AC-1: `npx vitest run test/jev-degraded.test.ts -t "missing key"`
> - AC-2: `npx vitest run test/jev-degraded.test.ts -t tokens`
> - AC-3: `npx vitest run test/jev-degraded.test.ts -t "no fabrication"`
> - AC-4: `npx vitest run test/jev-client.test.ts`
> 
> ## Targeted tests
> `npx vitest run test/jev-degraded.test.ts`
