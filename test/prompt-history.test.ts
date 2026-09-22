// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitize, verifySanitized, groupByBead, renderMarkdown, main, collectLogEntries, COMPACT_INSTRUCTIONS, digestEntryText, collectBeadPrompts, renderBeadPrompts} from '../scripts/prompt-history.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'history-'));
  roots.push(root);
  await mkdir(path.join(root, 'logs'));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('sanitize', () => {
  it('redacts every documented shape and rewrites only absolute repository paths', () => {
    const raw = '/home/person/repo/src/main.ts\nBearer abc.def\napi_key=small-key\n' + 'a'.repeat(40)
      + '\napp.workers.dev\nperson@example.com\nrelative/home/person/repo/file.ts';
    const result = sanitize(raw, '/home/person/repo');
    expect(result).toBe('src/main.ts\nBearer [redacted]\napi_key=[redacted]\n[redacted]\n[redacted-host]\n[redacted-email]\nrelative/home/person/repo/file.ts');
    expect(() => verifySanitized(result, 'fixture.log', 1)).not.toThrow();
  });
  it('handles quoted assignments, authorization headers and base64', () => {
    const result = sanitize('"token": "short secret", authorization: Bearer abc.def\nsecret=hidden\n' + 'Xy09+/'.repeat(8), '/repo');
    expect(result).not.toMatch(/short secret|abc\.def|hidden|Xy09/);
    expect(() => verifySanitized(result, 'fixture.log', 1)).not.toThrow();
  });
  it('streams files and produces chronological output with idempotent append', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'logs', 'b.log'), '[2026-09-21 12:00:00] alpha-123 later\n');
    await writeFile(path.join(root, 'logs', 'a.log'), '[2026-09-20 12:00:00] alpha-123 earlier\n');
    const entries = [];
    for await (const entry of collectLogEntries(path.join(root, 'logs'))) entries.push(entry);
    expect(entries.map(entry => entry.file)).toEqual(['a.log', 'b.log']);
    // The fixture root is a temporary directory, so its name is not the prefix
    // these ids carry; append round-trips only under the prefix that wrote it.
    await main(['--prefix', 'alpha'], root);
    await main(['--append', '--prefix', 'alpha'], root);
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output.match(/^## alpha-123$/gm)).toHaveLength(1);
    expect(output.match(/^<!-- entry /gm)).toHaveLength(2);
    expect(output.indexOf('earlier')).toBeLessThan(output.indexOf('later'));
  });
  it('renders empty logs explicitly', async () => {
    const root = await fixture();
    await main([], root);
    expect(await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8')).toContain('No log entries found.');
  });
});

describe('refuses', () => {
  it('rejects escaped credentials without exposing them or writing output', async () => {
    const root = await fixture();
    // An escaped separator, which redaction cannot see and verification decodes.
    // Assembled rather than written out, so this line is not itself a shape the
    // verifier refuses once a log quotes this file back into the corpus.
    const survivor = '{"token"' + String.raw`\u003a` + ' "private-value"}';
    await writeFile(path.join(root, 'logs', 'bad.log'), survivor);
    const result = spawnSync(process.execPath, [path.resolve('scripts/prompt-history.mjs'), '--logs', path.join(root, 'logs'), '--out', path.join(root, 'output.md')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad.log:1');
    expect(result.stderr).not.toContain('private-value');
    await expect(readFile(path.join(root, 'output.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves existing output when invalid UTF-8 is encountered', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'PROMPT_HISTORY.md'), 'existing');
    await writeFile(path.join(root, 'logs', 'bad.log'), Buffer.from([0xff]));
    await expect(main([], root)).rejects.toThrow('Invalid UTF-8 at bad.log:1');
    expect(await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8')).toBe('existing');
  });
});

describe('false positives', () => {
  it('accepts prose whose following word was redacted', () => {
    const result = sanitize('the plain-fetch client with Bearer auth and no streaming', '/repo');
    expect(result).toContain('Bearer [redacted]');
    expect(() => verifySanitized(result, 'run.log', 1)).not.toThrow();
  });
  it('accepts a rule that names a credential shape instead of carrying one', () => {
    const raw = String.raw`const bearer = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;`;
    expect(() => verifySanitized(sanitize(raw, '/repo'), 'run.log', 1)).not.toThrow();
  });
  it('redacts an assignment a log quoted from another log', () => {
    const result = sanitize(String.raw`{\"token\": \"private-value\"}`, '/repo');
    expect(result).not.toContain('private-value');
    expect(() => verifySanitized(result, 'run.log', 1)).not.toThrow();
  });
  it('redacts a key a log spelled with unicode escapes', () => {
    const result = sanitize('{"' + String.raw`\u0074` + 'oken": "private-value"}', '/repo');
    expect(result).not.toContain('private-value');
    expect(() => verifySanitized(result, 'run.log', 1)).not.toThrow();
  });
  it('still raises when a value survives beside a redacted one', () => {
    expect(() => verifySanitized('api_key=[redacted] token=survivor', 'run.log', 1)).toThrow('run.log:1');
  });
});

describe('grouping', () => {
  const entries = (...texts) => texts.map((text, i) => ({ text, file: 'run.log', line: i + 1, timestamp: '' }));

  it('keeps child ids and files the rest under the fallback', () => {
    const groups = groupByBead(entries('otel-judge-4i3.2 first', 'otel-judge-h3c second', 'ordinary words'), 'otel-judge');
    expect([...groups.keys()]).toEqual(['otel-judge-4i3.2', 'otel-judge-h3c', 'unattributed']);
    expect(renderMarkdown(groups)).toContain('ordinary words');
  });

  it('reads one corpus differently under each prefix', () => {
    const corpus = entries('alpha-123 first', 'other-project-abc.2 second');
    expect([...groupByBead(corpus, 'alpha').keys()]).toEqual(['alpha-123', 'unattributed']);
    expect([...groupByBead(corpus, 'other-project').keys()]).toEqual(['unattributed', 'other-project-abc.2']);
  });

  it('refuses a section named after a hyphenated ordinary word', () => {
    expect([...groupByBead(entries('re-read the top-level claude-opus notes'), 'otel-judge').keys()])
      .toEqual(['unattributed']);
  });

  it('refuses an id quoted from another workspace', () => {
    expect([...groupByBead(entries('other-project-abc.2 mentioned in passing'), 'otel-judge').keys()])
      .toEqual(['unattributed']);
  });
});

describe('llm-compact', () => {
  const starter = 'Read AGENTS.md first. One window, one issue.';
  async function corpus() {
    const root = await fixture();
    await writeFile(path.join(root, 'logs', 'a.log'),
      `[2026-09-20 12:00:00] alpha-123 ${starter}\n[2026-09-20 12:01:00] alpha-123 implemented the parser\n`);
    await writeFile(path.join(root, 'logs', 'b.log'),
      `[2026-09-21 12:00:00] alpha-456 ${starter}\n[2026-09-21 12:01:00] alpha-456 fixed the test\n`);
    return root;
  }
  // A stand-in for the model: names the starter it saw and narrates the rest.
  const requests: { section: string; part: number; of: number; entries: { text: string }[] }[] = [];
  const backend = async (instructions: string, payload: string) => {
    expect(instructions).toBe(COMPACT_INSTRUCTIONS);
    const request = JSON.parse(payload);
    requests.push(request);
    const seen = request.entries.map((entry: { text: string }) => entry.text).find((text: string) => text.includes(starter));
    const markdown = `## Summary\n\nSession-start prompt (listed once at the top)\n\nThen: ${request.entries.at(-1).text}`;
    return '```json\n' + JSON.stringify({ starters: [seen.slice(seen.indexOf('Read'))], markdown }) + '\n```';
  };
  afterEach(() => { requests.splice(0); vi.restoreAllMocks(); });

  it('replaces the document with compact sections and lists each session starter once at the top', async () => {
    const root = await corpus();
    await main(['--llm-compact', '--prefix', 'alpha'], root, { backend });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output.startsWith('# Prompt history\n\nGenerated: ')).toBe(true);
    expect(output.indexOf('## Session-start prompts')).toBeLessThan(output.indexOf('## alpha-123'));
    expect(output).toContain('recur throughout the sections below');
    expect(output.match(new RegExp(starter.replace(/[.]/g, '\\.'), 'g'))).toHaveLength(1);
    expect(output).toContain('> Read AGENTS.md first.');
    expect(output).toContain('Then: [2026-09-21 12:01:00] alpha-456 fixed the test');
    expect(output).not.toContain('<!-- entry');
    // The skeleton belongs to the script: a model heading at document level is demoted.
    expect(output).not.toMatch(/^## Summary$/m);
    expect(output).toMatch(/^### Summary$/m);
    expect(requests.map((request) => [request.section, request.part, request.of])).toEqual([['alpha-123', 1, 1], ['alpha-456', 1, 1]]);
  });

  it('prints the compact document under --dry-run without writing', async () => {
    const root = await corpus();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['--llm-compact', '--dry-run', '--prefix', 'alpha'], root, { backend });
    expect(String(write.mock.calls[0][0])).toContain('## Session-start prompts');
    await expect(readFile(path.join(root, 'PROMPT_HISTORY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renders empty logs without calling the backend', async () => {
    const root = await fixture();
    await main(['--llm-compact'], root, { backend });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output).toContain('## Session-start prompts');
    expect(output).toContain('None identified.');
    expect(output).toContain('No log entries found.');
    expect(requests).toHaveLength(0);
  });

  it('refuses --append together with --llm-compact', async () => {
    const root = await corpus();
    await expect(main(['--append', '--llm-compact'], root, { backend })).rejects.toThrow('Cannot combine --append with --llm-compact');
    await expect(readFile(path.join(root, 'PROMPT_HISTORY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a reply outside the contract', async () => {
    const root = await corpus();
    await expect(main(['--llm-compact', '--prefix', 'alpha'], root, { backend: async () => 'Here is your summary.' }))
      .rejects.toThrow('Compact output rejected: reply is not a JSON object');
    await expect(main(['--llm-compact', '--prefix', 'alpha'], root, { backend: async () => JSON.stringify({ starters: [], markdown: '' }) }))
      .rejects.toThrow('Compact output rejected: reply does not carry starters and markdown');
    await expect(main(['--llm-compact', '--prefix', 'alpha'], root, { backend: async () => JSON.stringify({ starters: [], markdown: '<!-- entry {} -->' }) }))
      .rejects.toThrow('Compact output rejected: reply reproduces raw entries');
    await expect(main(['--llm-compact', '--prefix', 'alpha'], root, { backend: async () => { throw new Error('Compact backend failed: exit 1'); } }))
      .rejects.toThrow('Compact backend failed: exit 1');
    await expect(readFile(path.join(root, 'PROMPT_HISTORY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strips raw entry dumps from an otherwise valid compact reply', async () => {
    const root = await corpus();
    await main(['--llm-compact', '--prefix', 'alpha'], root, {
      backend: async () => JSON.stringify({
        starters: [],
        markdown: 'Implemented the parser.\n<!-- entry {"x":1} -->\nVerified tests.',
      }),
    });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output).toContain('Implemented the parser');
    expect(output).toContain('Verified tests');
    expect(output).not.toMatch(/<!--\s*entry\s*\{/);
  });

  it('allows compact prose that names the entry marker without dumping raw entries', async () => {
    const root = await corpus();
    await main(['--llm-compact', '--prefix', 'alpha'], root, {
      backend: async () => JSON.stringify({
        starters: [],
        markdown: 'Changed grouping to bead ids. Discussed the <!-- entry metadata comment without dumping entries.',
      }),
    });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output).toContain('Discussed the <!-- entry metadata');
    expect(output).not.toMatch(/^<!--\s*entry\s/m);
  });

  it('llm-compact-unsafe: verifies the compact output and keeps the previous file when it fails', async () => {
    const root = await corpus();
    await writeFile(path.join(root, 'PROMPT_HISTORY.md'), 'existing');
    const unsafe = async () => JSON.stringify({ starters: [], markdown: 'fine line\napi_key=[redacted] token=survivor' });
    await expect(main(['--llm-compact', '--prefix', 'alpha'], root, { backend: unsafe })).rejects.toThrow('Unsafe content at compact output:');
    expect(await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8')).toBe('existing');
  });
});

describe('digestEntryText', () => {
  it('keeps assistant prose and stubs tool results', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I will fix the parser' }, { type: 'tool_use', name: 'Edit' }] },
    });
    expect(digestEntryText(assistant)).toContain('I will fix the parser');
    expect(digestEntryText(assistant)).toContain('[tool_use Edit]');
    const toolResult = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: '<!-- entry {"a":1} -->\n' + 'x'.repeat(5000) }] },
    });
    const digested = digestEntryText(toolResult);
    expect(digested).toMatch(/tool_result omitted/);
    expect(digested).not.toContain('<!-- entry');
  });

  it('passes status lines through', () => {
    expect(digestEntryText('[2026-09-21 12:00:00] worker claimed otel-judge-4i3.1')).toContain('worker claimed');
  });
});


describe('from-beads', () => {
  // Ortus is not on PATH in CI, so the harness arrives as a fixture; the live
  // read is exercised by the ship command on the machine that ships.
  const harness = {
    version: 'ortus 0.0.0-testfixture',
    backend: 'claude',
    prompts: [{
      name: 'goal',
      source: 'bundled (default)',
      phase: 'implementation',
      description: 'One-issue worker loop.',
      text: '# Goal\n\nRead AGENTS.md first.\n\n```bash\nbd ready\n```\n',
    }],
  };
  const loadHarness = async () => harness;
  const oneBead = async () => [JSON.stringify({
    id: 'otel-judge-demo1', title: 'Build the door', issue_type: 'task', description: 'Only a description.',
  })];
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes sanitized bead prompts and skips grind logs', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'logs', 'noise.log'), '[2026-09-20 12:00:00] should not appear\n');
    const exportBeads = async () => [
      JSON.stringify({
        id: 'otel-judge-demo1',
        title: 'Build the door',
        issue_type: 'task',
        status: 'closed',
        description: '## Objective\n\nShip the Worker door with Bearer secret.',
        design: '## Scope\n\nUse api_key=super-secret-value-here-32chars!! in tests only — will redact.',
        acceptance_criteria: '## Observable criteria\n\n- AC-1: door responds',
      }),
      JSON.stringify({
        id: 'otel-judge-demo2',
        title: 'Empty optional fields',
        issue_type: 'task',
        status: 'open',
        description: 'Only a description.',
      }),
    ];
    await main(['--from-beads'], root, { exportBeads, loadHarness });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output).toContain('Source: beads');
    expect(output).toContain('## otel-judge-demo1');
    expect(output).toContain('Build the door');
    expect(output).toContain('Ship the Worker door');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('super-secret-value-here-32chars!!');
    expect(output).toContain('## otel-judge-demo2');
    expect(output).not.toContain('should not appear');
  });

  it('prepends the version-pinned harness ahead of the first bead section', async () => {
    const root = await fixture();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['--from-beads', '--dry-run'], root, { exportBeads: oneBead, loadHarness });
    const output = String(write.mock.calls[0][0]);
    expect(output).toContain('## Ortus harness');
    expect(output.indexOf('## Ortus harness')).toBeLessThan(output.indexOf('## otel-judge-demo1'));
    expect(output).toContain('ortus 0.0.0-testfixture');
    expect(output).toContain('### goal (implementation)');
    expect(output).toContain('Read AGENTS.md first.');
    // The prompt's own fenced example must not close the block holding it.
    expect(output).toContain('````text');
    expect(output).toContain('Only a description.');
    await expect(readFile(path.join(root, 'PROMPT_HISTORY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts secret-shaped harness text and refuses what redaction cannot see', async () => {
    const root = await fixture();
    const withSecret = { ...harness, prompts: [{ ...harness.prompts[0],
      text: 'Never print api_key=super-secret-value-here-32chars!! in a log.' }] };
    await main(['--from-beads'], root, { exportBeads: oneBead, loadHarness: async () => withSecret });
    const output = await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8');
    expect(output).toContain('api_key=[redacted]');
    expect(output).not.toContain('super-secret-value-here-32chars!!');

    // An escaped separator is invisible to redaction and visible to verification,
    // so the harness has to fail the document rather than publish the value.
    const smuggled = { ...harness, prompts: [{ ...harness.prompts[0],
      text: '{"token"' + String.raw`\u003a` + ' "private-value"}' }] };
    await expect(main(['--from-beads'], root, { exportBeads: oneBead, loadHarness: async () => smuggled }))
      .rejects.toThrow('Unsafe content at harness goal:1');
    expect(await readFile(path.join(root, 'PROMPT_HISTORY.md'), 'utf8')).toContain('api_key=[redacted]');
  });

  it('refuses --from-beads with --llm-compact', async () => {
    const root = await fixture();
    await expect(main(['--from-beads', '--llm-compact'], root, { exportBeads: async () => [] }))
      .rejects.toThrow('Cannot combine --from-beads with --llm-compact');
  });
});
