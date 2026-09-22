// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitize, verifySanitized, groupByBead, renderMarkdown, main, collectLogEntries } from '../scripts/prompt-history.mjs';

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
    await main([], root);
    await main(['--append'], root);
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
    await writeFile(path.join(root, 'logs', 'bad.log'), String.raw`{"\u0074oken": "private-value"}`);
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

describe('grouping', () => {
  it('accepts different prefixes, child ids and unattributed lines', () => {
    const entries = ['alpha-123 first', 'other-project-abc.2 second', 'ordinary words'].map((text, i) => ({ text, file: 'run.log', line: i + 1, timestamp: '' }));
    const groups = groupByBead(entries);
    expect([...groups.keys()]).toEqual(['alpha-123', 'other-project-abc.2', 'unattributed']);
    expect(renderMarkdown(groups)).toContain('ordinary words');
  });
});
