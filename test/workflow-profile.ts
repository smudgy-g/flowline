// Workflow simulations run against a throwaway project, not the installing team's configuration.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-project-"));
mkdirSync(join(root, ".factory/acceptance"), { recursive: true });
writeFileSync(
  join(root, ".factory/config.json"),
  JSON.stringify({
    repo: "example/service",
    base: "main",
    paths: { tests: ["**/*_test.go"], protected: [".factory/**"], sensitive: ["go.mod"] },
    sandbox: { kit: "shell", cpus: 2, memory: "2g", allowlist: [], maxConcurrent: 1 },
    commands: {
      changedCode: ["**/*.go"],
      setup: [["go", "mod", "download"]],
      autofix: [["gofmt", "-w", "--", "{changedCode}"]],
      check: [["go", "vet", "./..."]],
      gates: [["go", "test", "./..."]],
      env: { CI: "true" },
    },
    skills: { packs: ["core"], coder: { always: [] }, codeReviewers: ["architect", "interrogate", "change-impact"] },
  }),
);
process.env.FACTORY_PROJECT = root;
process.env.FACTORY_STATE = join(root, "state");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
