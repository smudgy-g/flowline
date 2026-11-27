import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { githubRepo, openLocalPr, prInNote, type Gh } from '../src/local-pr.ts';

const repo = 'smudgy-g/cv-exe';
const url = `https://github.com/${repo}/pull/1`;

test('only GitHub remotes can offer PR creation, including personal SSH aliases', () => {
  assert.equal(githubRepo('git@github.com-personal:smudgy-g/cv-exe.git'), repo);
  assert.equal(githubRepo('https://github.com/smudgy-g/cv-exe.git'), repo);
  assert.equal(githubRepo('git@example.com:smudgy-g/cv-exe.git'), undefined);
  assert.equal(githubRepo('git@github.com:org/repo.git/evil'), undefined);
});

test('PR button uses the full delivery note as the draft body, reuses a PR and repairs an empty body', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-pr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'delivery.md');
  await writeFile(file, '# Footer link\n\n## Verification\nProduction build passed\n');
  const calls: string[][] = [];
  let existing: { url: string; body: string; state: string } | undefined;

  const fake: Gh = async args => {
    calls.push(args);

    if (args[1] === 'view') {
      if (!existing) throw new Error('no PR');

      return JSON.stringify(existing);
    }

    if (args[1] === 'create') return url;

    if (args[1] === 'edit') return url;

    throw new Error('unexpected gh call');
  };

  assert.equal(await openLocalPr(repo, 'main', 'footer-link', file, fake), url);
  assert.deepEqual(calls[1], ['pr', 'create', '--repo', repo, '--draft', '--base', 'main', '--head', 'footer-link',
    '--title', 'Footer link', '--body-file', file]);
  assert.equal(prInNote(await readFile(file, 'utf8'), repo), url);
  existing = { url, body: '', state: 'OPEN' };
  calls.length = 0;
  assert.equal(await openLocalPr(repo, 'main', 'footer-link', file, fake), url);
  assert.deepEqual(calls[1], ['pr', 'edit', url, '--repo', repo, '--body-file', file]);
  existing.body = 'Human-written description';
  calls.length = 0;
  await openLocalPr(repo, 'main', 'footer-link', file, fake);
  assert.equal(calls.length, 1, 'a populated PR is not overwritten');
  existing.state = 'CLOSED';
  await assert.rejects(openLocalPr(repo, 'main', 'footer-link', file, fake), /existing GitHub PR is closed/);
});
