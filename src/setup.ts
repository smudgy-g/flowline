// `flowline setup`: turn the repository you are standing in into a project this factory can work on. It writes
// `.factory/`, never anything else, and refuses rather than overwrite what is already there.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ok = (text: string) => console.log(`  ✓ ${text}`);
const warn = (text: string) => console.log(`  ! ${text}`);

/** The defaults a new project starts from: enough to boot, not enough to pass acceptance. */
const template = (base: string) => ({
  base,
  paths: { tests: ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"], protected: [".factory/**"], sensitive: [] },
  sandbox: { kit: "shell", cpus: 2, memory: "2g", allowlist: [], maxConcurrent: 1 },
  commands: {
    changedCode: ["**/*"],
    setup: [] as string[][],
    autofix: [] as string[][],
    check: [] as string[][],
    gates: [["echo", "set commands.gates in .factory/config.json"]],
    env: { CI: "true" },
  },
});

export async function setup(baseArg?: string) {
  const root = gitRoot();
  const dir = join(root, ".factory");
  console.log(`Setting up ${root}`);

  const base = baseArg ?? currentBranch(root) ?? "main";
  const config = join(dir, "config.json");

  if (existsSync(config)) {
    warn(`.factory/config.json exists; leaving it alone`);
  } else {
    await mkdir(dir, { recursive: true });
    await writeFile(config, `${JSON.stringify(template(base), null, 2)}\n`);
    ok(`.factory/config.json (base branch "${base}")`);
  }

  const ignore = join(dir, ".gitignore");

  if (existsSync(ignore)) warn(".factory/.gitignore exists; leaving it alone (ignore assets/ and claims/ if needed)");
  else {
    await writeFile(ignore, "# Downloaded acceptance toolchains and caches (rebuild locally).\nassets/\n# Local work-item locks (never share across clones).\nclaims/\n");
    ok(".factory/.gitignore (local assets and claims only)");
  }

  await mkdir(join(dir, "items"), { recursive: true });
  await mkdir(join(dir, "acceptance"), { recursive: true });
  const adapter = join(dir, "acceptance/run.sh");

  if (existsSync(adapter)) warn(".factory/acceptance/run.sh exists; leaving it alone");
  else {
    await copyFile(join(installRoot, "templates/acceptance/run.sh"), adapter);
    ok(".factory/acceptance/run.sh (a stub that refuses to pass)");
  }

  for (const [what, check] of checks(root)) (check() ? ok : warn)(what);

  console.log(`
Next (examples and explanations: ${join(installRoot, "docs/config.md")}):
  1. Choose your work item tracker: local files in .factory/items/ (default), or GitHub Issues.
     For GitHub Issues, set "tracker": { "command": ["github"] } in .factory/config.json and sign into gh
     before your first run. Do not switch trackers during a run.
  2. In .factory/config.json, replace the placeholder commands.gates with your project's real checks and tests.
  3. Choose a sandbox.kit with your tools, or install them in commands.setup; allow only the download hosts needed.
  4. Replace .factory/acceptance/run.sh with a real offline check of the pushed commit (the stub cannot pass).
  5. Commit .factory (including .factory/.gitignore) and push it to ${base}. Do not ignore .factory/ itself:
     worktrees need the config, scripts and acceptance adapter. If acceptance.assets lives outside .factory/assets/,
     add that directory to your project's .gitignore separately. Claims are local locks; never commit them.
     Each work item is built in a fresh worktree of origin/${base}, so anything a sandbox runs must be on that branch.
  6. Describe a work item in .factory/items/<name>.md (or use New item on the board), then: flowline board start`);
}

function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Not inside a git repository: the factory works on a checkout with an origin remote.");
  }
}

const quiet = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function currentBranch(root: string) {
  try { return quiet("git", ["branch", "--show-current"], root) || undefined; } catch { return undefined; }
}

/** What a run will need, reported now rather than as a failure halfway through a lane. */
function checks(root: string): Array<[string, () => boolean]> {
  const has = (cmd: string, args: string[], cwd = root) => {
    try { quiet(cmd, args, cwd); return true; } catch { return false; }
  };

  return [
    ["git origin remote (the factory pushes task branches to it)", () => has("git", ["remote", "get-url", "origin"])],
    ["sbx is installed (every project command runs in a sandbox)", () => has("sbx", ["--version"])],
    ["sbx has a deny-all network policy", () => {
      try {
        const rules = JSON.parse(quiet("sbx", ["--no-input", "policy", "ls", "--json"], root)).rules ?? [];
        return rules.some((r: { id: string; decision: string }) => r.id === "default-deny-all" && r.decision === "deny");
      } catch { return false; }
    }],
    ["pi is installed with a managed install (the agents run on it)", () =>
      existsSync(join(process.env.PI_MANAGED_INSTALL_ROOT || join(process.env.HOME ?? "", ".pi/agent/install"), "current-version"))],
  ];
}
