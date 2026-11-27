import assert from 'node:assert/strict';
import test from 'node:test';
import './workflow-profile.ts';
import { githubCompareUrl } from '../src/board.ts';

test('local delivery offers GitHub compare only for GitHub remotes, with the exact branch', () => {
  assert.equal(githubCompareUrl('git@github.com-personal:smudgy-g/cv-exe.git', 'main', 'site-footer-link-link-author-s'),
    'https://github.com/smudgy-g/cv-exe/compare/main...site-footer-link-link-author-s?expand=1');
  assert.equal(githubCompareUrl('https://github.com/org/repo.git', 'staging', 'feature/a'),
    'https://github.com/org/repo/compare/staging...feature%2Fa?expand=1');
  assert.equal(githubCompareUrl('git@example.com:org/repo.git', 'main', 'branch'), undefined);
  assert.equal(githubCompareUrl('git@github.com:org/repo.git/evil', 'main', 'branch'), undefined);
});
