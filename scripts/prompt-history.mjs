import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The gap between a key and its value, which never crosses a line break.
 *
 * A credential and its value live on one line: a key with nothing after it on
 * its own line has no value, rather than owning whatever the next line starts
 * with. Spelling that gap `\s*` let the pattern step over the newline, so a
 * redacted `api_key=` read as a key whose value was the following line — the
 * verifier then refused documents that had in fact been fully redacted.
 */
const gap = String.raw`[^\S\r\n]`;
/**
 * One character of a key, as itself or as the `\u00xx` escape a log wrote it as.
 *
 * A log that quotes a log escapes the escape, so the backslash run is counted
 * loosely, and both letter cases are listed because the hex differs between
 * them while the surrounding match is case-insensitive.
 */
const escapable = (word) => [...word].map((character) => {
  const codes = [...new Set([character.toLowerCase(), character.toUpperCase()])]
    .map((form) => form.charCodeAt(0).toString(16).padStart(4, '0'));
  return `(?:${character}|\\\\+u(?:${codes.join('|')}))`;
}).join('');
const key = `(?:[\\w-]*(?:${escapable('api')}[_-]?${escapable('key')}|${escapable('token')}`
  + `|${escapable('secret')}|${escapable('authorization')})[\\w-]*)`;
/**
 * A quote that may arrive escaped, because a log that quotes a log escapes it again.
 *
 * Redaction reads the literal bytes while verification decodes `\"` first, so an
 * escaped `\"token\": \"value\"` was invisible to the rule and visible to the
 * check: the generator refused documents it had never had a chance to clean.
 * Matching the escaped form here closes that gap on the redaction side, which
 * keeps the published bytes the ones the session actually produced.
 */
const quote = String.raw`\\*["']`;
const assignment = new RegExp(`${key}(?:${quote})?${gap}*[:=]${gap}*(?:${quote}[^"'\\r\\n]*${quote}|(?:Bearer${gap}+)?[^\\s,;}&]+)`, 'gi');
const bearer = new RegExp(`\\bBearer${gap}+[A-Za-z0-9._~+/-]+=*`, 'gi');
const longValue = /[A-Za-z0-9_+/=-]{32,}/g;
const hostname = /\b(?:[a-z0-9-]+\.)+workers\.dev\b/gi;
/** Local machine / account names that must never ship in a public disclosure. */
const localMachine = /\bCONDOR2\b/gi;
const localHome = /\/home\/condor\b/g;
const localUserAt = /\bcondor@/gi;

const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Redact documented credential shapes in their prescribed order. */
export function sanitize(text, repoRoot) {
  const root = path.resolve(repoRoot);
  return text
    .replace(new RegExp(`(^|[\\s"'\x60=(])${escapeRegex(root)}(?=/|$|[\\s"'\x60),:])/?`, 'gm'), '$1')
    .replace(assignment, (match) => match.replace(/([:=]\s*)[\s\S]*$/, '$1[redacted]'))
    .replace(bearer, 'Bearer [redacted]')
    .replace(longValue, '[redacted]')
    .replace(hostname, '[redacted-host]')
    .replace(localMachine, '[redacted-machine]')
    .replace(localHome, '[redacted-home]')
    .replace(localUserAt, '[redacted-user]@')
    .replace(email, '[redacted-email]');
}

/** Verify independently, including JSON escape sequences a literal rule misses. */
export function verifySanitized(text, file, line) {
  const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["\\/])/g, '$1');
  // A marker stands in for what it replaced: deleting it joined the text on
  // either side, so redacted prose read back as `Bearer  and` and a redacted
  // value read as the word after it. `]` is excluded by every rule below, so it
  // ends a run the way the removed value did without hiding a second secret.
  const withoutMarkers = decoded.replace(/\[redacted(?:-host|-email)?\]/g, ']');
  const credential = new RegExp(`${key}["']?${gap}*[:=]${gap}*["']?[^\\s"',;}\\]]`, 'i');
  // Refuse the shape redaction claims to remove, character class included: a
  // looser class made the rules' own prose and `const bearer = /…/` unsafe.
  if (credential.test(withoutMarkers) || new RegExp(`\\bBearer${gap}+[A-Za-z0-9._~+/-]`, 'i').test(withoutMarkers)
      || [longValue, hostname, email, localMachine, localHome, localUserAt].some((pattern) => new RegExp(pattern.source, 'i').test(withoutMarkers))) {
    throw new Error(`Unsafe content at ${file}:${line}`);
  }
}

async function* filesUnder(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(file);
    else if (entry.isFile()) yield file;
  }
}

/** Decode strictly and stream lines instead of reading all raw logs into memory. */
export async function* collectLogEntries(dir) {
  for await (const file of filesUnder(dir)) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', line = 0, timestamp = '';
    const entry = (text) => {
      line++;
      const match = text.match(/^\[?(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)/);
      if (match) timestamp = match[1].replace(' ', 'T');
      return { file: path.relative(dir, file), line, timestamp, text: text.replace(/\r$/, '') };
    };
    try {
      for await (const chunk of createReadStream(file)) {
        pending += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          yield entry(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      }
      pending += decoder.decode();
    } catch (error) {
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
        throw new Error(`Invalid UTF-8 at ${path.relative(dir, file)}:${line + 1}`);
      }
      throw error;
    }
    if (pending) yield entry(pending);
  }
}

/**
 * File each entry under every bead id it names, and the rest under one fallback.
 *
 * The workspace prefix is supplied rather than inferred. A pattern loose enough
 * to recognise any workspace's ids also recognises `top-level`, `re-read` and
 * `claude-opus`, so a corpus of ordinary English turned into hundreds of
 * sections, each carrying its own copy of every entry that happened to use the
 * word; the duplication alone put the document past the longest string the
 * runtime can hold. Anchoring to one prefix is what keeps a section an
 * attribution rather than a concordance.
 */
export function groupByBead(entries, prefix) {
  // Prefixes may themselves contain hyphens; child issue suffixes are numeric.
  const idPattern = new RegExp(`\\b${escapeRegex(prefix)}-[a-z0-9]{3,8}(?:\\.\\d+)*\\b`, 'g');
  const groups = new Map();
  for (const entry of entries) {
    const ids = [...new Set(entry.text.match(idPattern) ?? ['unattributed'])];
    for (const id of ids) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(entry);
    }
  }
  return groups;
}

/** One copy of each entry, oldest first; a log that was collected twice is still one event. */
function orderedUnique(entries) {
  const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || a.file.localeCompare(b.file) || a.line - b.line);
}

const sortedSections = (groups) => [...groups].sort(([a], [b]) => a.localeCompare(b));

export function renderMarkdown(groups, now = new Date()) {
  let output = `# Prompt history\n\nGenerated: ${now.toISOString()}\n`;
  if (!groups.size) return `${output}\nNo log entries found.\n`;
  for (const [id, entries] of sortedSections(groups)) {
    output += `\n## ${id}\n`;
    for (const entry of orderedUnique(entries)) {
      // Metadata permits lossless append; quoted text cannot introduce Markdown headings.
      output += `\n<!-- entry ${JSON.stringify(entry)} -->\n> ${entry.timestamp || 'undated'} | ${entry.file}:${entry.line}\n>\n`;
      output += entry.text.split('\n').map((line) => `> ${line}`).join('\n') + '\n';
    }
  }
  return output;
}

/**
 * Characters of log text offered to the model per call.
 *
 * A grind log line is one streamed JSON event and can run past three hundred
 * thousand characters on its own, so the budget bounds both how many entries
 * share a call and how much of one entry survives; the tail of an oversized
 * entry is cut with a marker rather than pushing the call past the context
 * the model can hold.
 */
const COMPACT_CHUNK_CHARS = 240_000;

/**
 * What one compact call is asked to do. Written to name no credential shape,
 * because a later log may quote this file back into the corpus.
 */
export const COMPACT_INSTRUCTIONS = [
  'You are compacting one section of an AI-assisted coding prompt history for public disclosure.',
  'Standard input carries a JSON object: {"section","part","of","entries":[{"timestamp","file","line","text"}]}.',
  'Each entry is one sanitized log line from an ortus grind run: orchestrator status lines, JSON events streamed by a coding agent (assistant text, tool calls, tool results), and the prompts the operator or orchestrator gave the agent.',
  'Answer with one JSON object and nothing else, without a code fence: {"starters":[...],"markdown":"..."}.',
  '- "starters": the full text of every prompt in these entries that starts a session: the standing instruction a worker receives at launch, such as a goal prompt, session rules, or an issue-authoring contract. Copy each verbatim, once. They are collected and listed once at the top of the document.',
  '- "markdown": a compact, readable account of this part in GitHub Markdown: what was asked, what the agent decided, what it changed, what it verified, in order. Quote short prompt fragments where they carry the meaning. Where an entry is a session-start prompt, write the single line "Session-start prompt (listed once at the top)" instead of restating it. Leave out tool-result payloads, progress spinners, and repeated status lines. Use headings of level three or deeper only; the document supplies levels one and two. Never emit raw HTML comment lines that dump entry metadata JSON; narrate in prose instead.',
  '- Keep markers such as [redacted], [redacted-host] and [redacted-email] exactly as they are; never guess what they replaced.',
  '- Do not invent facts. When the entries carry nothing meaningful, "markdown" may be one line saying so.',
].join('\n');

/**
 * The Claude backend the grinds on this machine already use, in print mode.
 *
 * The instructions travel as the prompt and the chunk on standard input, with
 * tools, hooks, settings and MCP servers switched off so the call is a plain
 * completion and nothing in the repository configuration runs under it.
 */
export function claudeBackend(instructions, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', instructions, '--output-format', 'text', '--tools', '',
      '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`Compact backend failed: ${error.code ?? error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Compact backend failed: exit ${code ?? signal}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

/** Split one section's entries into calls that fit the budget, cutting an entry only when it alone exceeds it. */
function chunkEntries(entries) {
  const chunks = [];
  let current = [], size = 0;
  for (const entry of entries) {
    let text = entry.text;
    if (text.length > COMPACT_CHUNK_CHARS) {
      text = `${text.slice(0, COMPACT_CHUNK_CHARS)} [cut: ${text.length - COMPACT_CHUNK_CHARS} more characters]`;
    }
    if (current.length && size + text.length > COMPACT_CHUNK_CHARS) {
      chunks.push(current);
      current = []; size = 0;
    }
    current.push({ ...entry, text });
    size += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Read one reply against the contract, refusing anything else.
 *
 * Document-level headings are demoted rather than refused: the skeleton is the
 * script's, and a model that titled its part is not a reason to discard an
 * hour of calls. Raw entry metadata is refused, because reproducing it is the
 * one thing the compact pass exists to stop.
 */
function parseCompactReply(reply) {
  const body = reply.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error('Compact output rejected: reply is not a JSON object'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || !Array.isArray(parsed.starters) || parsed.starters.some((starter) => typeof starter !== 'string')
      || typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) {
    throw new Error('Compact output rejected: reply does not carry starters and markdown');
  }
  // Refuse the raw dump shape (metadata comment + JSON payload), not prose that
  // names the marker. Bead work on the generator itself legitimately discusses
  // `<!-- entry` without reproducing the transcript format.
  if (/<!--\s*entry\s*\{/.test(parsed.markdown) || /^<!--\s*entry\s/m.test(parsed.markdown)) {
    throw new Error('Compact output rejected: reply reproduces raw entries');
  }
  return {
    starters: parsed.starters,
    markdown: parsed.markdown.trim().replace(/^(#{1,2})(?=\s)/gm, '###'),
  };
}

/**
 * Rewrite grouped entries into one compact document through the backend.
 *
 * Every section is sent in order, part by part; the model names the
 * session-start prompts it saw and the script lists each once at the top,
 * stating there that they recur below. The finished document is verified line
 * by line before it is returned, so nothing the model wrote can reach the
 * file unless it would have passed as a log line.
 */
export async function compactGroups(groups, backend = claudeBackend, now = new Date()) {
  const starters = new Map();
  const sections = [];
  let count = 0;
  for (const [id, entries] of sortedSections(groups)) {
    const ordered = orderedUnique(entries);
    count += ordered.length;
    const chunks = chunkEntries(ordered);
    const parts = [];
    for (const [index, chunk] of chunks.entries()) {
      process.stderr.write(`compact: ${id} part ${index + 1}/${chunks.length}\n`);
      const payload = JSON.stringify({ section: id, part: index + 1, of: chunks.length, entries: chunk });
      const reply = parseCompactReply(await backend(COMPACT_INSTRUCTIONS, payload));
      for (const starter of reply.starters) {
        const key = starter.replace(/\s+/g, ' ').trim();
        if (key && !starters.has(key)) starters.set(key, starter.trim());
      }
      parts.push(reply.markdown);
    }
    sections.push(`\n## ${id}\n\n${parts.join('\n\n')}\n`);
  }

  let document = `# Prompt history\n\nGenerated: ${now.toISOString()}\n`;
  document += `\nCompacted by the Claude CLI from ${count} log entries in ${sections.length} sections. `
    + 'Regenerate without --llm-compact for the raw transcript.\n';
  document += '\n## Session-start prompts\n\n';
  document += 'These prompts open sessions and recur throughout the sections below. Each is listed once here; '
    + 'a section says "Session-start prompt (listed once at the top)" where one recurred instead of repeating it.\n';
  if (!starters.size) document += '\nNone identified.\n';
  for (const [index, starter] of [...starters.values()].entries()) {
    document += `\n### Starter ${index + 1}\n\n${starter.split('\n').map((line) => `> ${line}`).join('\n')}\n`;
  }
  if (!sections.length) document += '\nNo log entries found.\n';
  document += sections.join('');

  document.split('\n').forEach((line, index) => verifySanitized(line, 'compact output', index + 1));
  return document;
}

function parseExisting(text, prefix) {
  if (!text.startsWith('# Prompt history\n\nGenerated: ')) throw new Error('Unrecognized append document');
  const entries = [];
  for (const match of text.matchAll(/^<!-- entry (.*) -->$/gm)) {
    const entry = JSON.parse(match[1]);
    if (typeof entry.text !== 'string' || typeof entry.file !== 'string'
        || typeof entry.timestamp !== 'string' || !Number.isInteger(entry.line)) {
      throw new Error('Invalid append entry');
    }
    entries.push(entry);
  }
  // Reject edits or unsupported documents rather than silently discarding content.
  const timestamp = text.match(/^Generated: (.+)$/m)?.[1];
  if (renderMarkdown(groupByBead(entries, prefix), new Date(timestamp)) !== text) {
    throw new Error('Append document differs from generated format');
  }
  return entries;
}

/**
 * Generate the document. `options.backend` replaces the Claude call under
 * `--llm-compact`, so a test can hold the contract without a model in the room.
 */
export async function main(args = process.argv.slice(2), repoRoot = process.cwd(), options = {}) {
  // bd derives its own prefix from the repository directory name, so the default
  // agrees with the ids the logs actually carry without being told.
  let logs = 'logs', out = 'PROMPT_HISTORY.md', append = false, dryRun = false, llmCompact = false;
  let prefix = path.basename(path.resolve(repoRoot));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      console.log('Usage: node scripts/prompt-history.mjs [--logs <dir>] [--out <path>] [--prefix <prefix>] [--append] [--dry-run] [--llm-compact]\nDefaults: --logs logs/ --out PROMPT_HISTORY.md --prefix <repository directory name>\n--llm-compact rewrites the sanitized history into compact Markdown through the Claude CLI, listing session-start prompts once at the top; ship runs use it, and it cannot be combined with --append');
      return;
    }
    if (arg === '--append') append = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--llm-compact') llmCompact = true;
    else if (arg === '--logs' || arg === '--out' || arg === '--prefix') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--logs') logs = value;
      else if (arg === '--out') out = value;
      else prefix = value;
    } else throw new Error('Unknown argument; use --help');
  }
  // A compact document carries no entry metadata, so there is nothing for a
  // later append to read back; the combination is refused rather than defined.
  if (append && llmCompact) throw new Error('Cannot combine --append with --llm-compact');
  const destination = path.resolve(repoRoot, out);
  const entries = [];
  if (append) {
    try { entries.push(...parseExisting(await readFile(destination, 'utf8'), prefix)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for await (const entry of collectLogEntries(path.resolve(repoRoot, logs))) entries.push({
    ...entry, file: sanitize(entry.file, repoRoot), text: sanitize(entry.text, repoRoot),
  });
  for (const entry of entries) {
    verifySanitized(entry.text, entry.file, entry.line);
    verifySanitized(entry.file, 'log filename', entry.line);
  }
  const groups = groupByBead(entries, prefix);
  const document = llmCompact
    ? await compactGroups(groups, options.backend ?? claudeBackend)
    : renderMarkdown(groups);
  if (dryRun) { process.stdout.write(document); return; }
  // Delay all output writes until collection and verification have succeeded.
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, document, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Library errors can contain raw input, so expose only our controlled diagnostics.
    const safe = /^(Unsafe content at |Invalid UTF-8 at |Missing value for |Unknown argument|Unrecognized append document|Invalid append entry|Append document differs|Cannot combine |Compact backend failed|Compact output rejected)/;
    console.error(safe.test(error.message) ? error.message : 'Prompt history generation failed');
    process.exitCode = 1;
  });
}
