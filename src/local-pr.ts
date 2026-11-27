// GitHub is optional for the local tracker: its delivered note remains the merge receipt.
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type Gh = (args: string[]) => Promise<string>;
const gh: Gh = async args => (await exec('gh', args, { timeout: 30_000 })).stdout.trim();

export function githubRepo(remote: string): string | undefined {
  return /^(?:git@(?:github\.com(?:-[\w-]+)?|ssh\.github\.com):|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
}

export function prInNote(text: string, repo: string): string | undefined {
  const url = text.match(/^GitHub PR: (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/m)?.[1];
  return url?.startsWith(`https://github.com/${repo}/pull/`) ? url : undefined;
}

/** Called only by the finished local card, after checking that its note belongs to this run. */
export async function openLocalPr(repo: string, base: string, branch: string, file: string, runGh: Gh = gh) {
  const note = await readFile(file, 'utf8');
  const title = /^# (.+)$/m.exec(note)?.[1];

  if (!title) throw new Error('The delivery note has no PR title');

  let current: { url: string; body: string; state: string } | undefined;

  try { current = JSON.parse(await runGh(['pr', 'view', branch, '--repo', repo, '--json', 'url,body,state'])); }
  catch { /* No PR yet; create will report auth or network errors if those caused the lookup to fail. */ }

  if (current && current.state !== 'OPEN') throw new Error(`The existing GitHub PR is ${current.state.toLowerCase()}; no new PR was created`);

  const url = current ? current.url : (await runGh([
    'pr', 'create', '--repo', repo, '--draft', '--base', base, '--head', branch,
    '--title', title, '--body-file', file,
  ])).trim();

  if (!new RegExp(`^https://github\\.com/${repo.replaceAll('.', '\\.')}\\/pull\\/\\d+$`).test(url))
    throw new Error('GitHub did not return a PR URL for this repository');

  // A PR opened earlier from the compare page can be repaired without replacing a human-written description.
  if (current && !current.body.trim()) await runGh(['pr', 'edit', url, '--repo', repo, '--body-file', file]);

  if (!prInNote(note, repo)) await appendFile(file, `\nGitHub PR: ${url}\n`);

  return url;
}
