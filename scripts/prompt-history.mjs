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
const key = String.raw`\b(?:[\w-]*(?:api[_-]?key|token|secret|authorization)[\w-]*)`;
const assignment = new RegExp(`${key}["']?${gap}*[:=]${gap}*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|(?:Bearer${gap}+)?[^\\s,;}&]+)`, 'gi');
const bearer = new RegExp(`\\bBearer${gap}+[A-Za-z0-9._~+/-]+=*`, 'gi');
const longValue = /[A-Za-z0-9_+/=-]{32,}/g;
const hostname = /\b(?:[a-z0-9-]+\.)+workers\.dev\b/gi;
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
    .replace(email, '[redacted-email]');
}

/** Verify independently, including JSON escape sequences a literal rule misses. */
export function verifySanitized(text, file, line) {
  const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["\\/])/g, '$1');
  const withoutMarkers = decoded.replace(/\[redacted(?:-host|-email)?\]/g, '');
  const credential = new RegExp(`${key}["']?${gap}*[:=]${gap}*["']?[^\\s"',;}\\]]`, 'i');
  if (credential.test(withoutMarkers) || new RegExp(`\\bBearer${gap}+[^\\s\\]}]`, 'i').test(withoutMarkers)
      || [longValue, hostname, email].some((pattern) => new RegExp(pattern.source, 'i').test(withoutMarkers))) {
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

export function groupByBead(entries) {
  const groups = new Map();
  for (const entry of entries) {
    // Prefixes may themselves contain hyphens; child issue suffixes are numeric.
    const ids = [...new Set(entry.text.match(/\b[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-[a-z0-9]{3,8}(?:\.\d+)*\b/g) ?? ['unattributed'])];
    for (const id of ids) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(entry);
    }
  }
  return groups;
}

export function renderMarkdown(groups, now = new Date()) {
  let output = `# Prompt history\n\nGenerated: ${now.toISOString()}\n`;
  if (!groups.size) return `${output}\nNo log entries found.\n`;
  for (const [id, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    output += `\n## ${id}\n`;
    const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
    const ordered = [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)
      || a.file.localeCompare(b.file) || a.line - b.line);
    for (const entry of ordered) {
      // Metadata permits lossless append; quoted text cannot introduce Markdown headings.
      output += `\n<!-- entry ${JSON.stringify(entry)} -->\n> ${entry.timestamp || 'undated'} | ${entry.file}:${entry.line}\n>\n`;
      output += entry.text.split('\n').map((line) => `> ${line}`).join('\n') + '\n';
    }
  }
  return output;
}

function parseExisting(text) {
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
  if (renderMarkdown(groupByBead(entries), new Date(timestamp)) !== text) {
    throw new Error('Append document differs from generated format');
  }
  return entries;
}

export async function main(args = process.argv.slice(2), repoRoot = process.cwd()) {
  let logs = 'logs', out = 'PROMPT_HISTORY.md', append = false, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      console.log('Usage: node scripts/prompt-history.mjs [--logs <dir>] [--out <path>] [--append] [--dry-run]\nDefaults: --logs logs/ --out PROMPT_HISTORY.md');
      return;
    }
    if (arg === '--append') append = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--logs' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--logs') logs = value;
      else out = value;
    } else throw new Error('Unknown argument; use --help');
  }
  const destination = path.resolve(repoRoot, out);
  const entries = [];
  if (append) {
    try { entries.push(...parseExisting(await readFile(destination, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for await (const entry of collectLogEntries(path.resolve(repoRoot, logs))) entries.push({
    ...entry, file: sanitize(entry.file, repoRoot), text: sanitize(entry.text, repoRoot),
  });
  for (const entry of entries) {
    verifySanitized(entry.text, entry.file, entry.line);
    verifySanitized(entry.file, 'log filename', entry.line);
  }
  const document = renderMarkdown(groupByBead(entries));
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
    const safe = /^(Unsafe content at |Invalid UTF-8 at |Missing value for |Unknown argument|Unrecognized append document|Invalid append entry|Append document differs)/;
    console.error(safe.test(error.message) ? error.message : 'Prompt history generation failed');
    process.exitCode = 1;
  });
}
