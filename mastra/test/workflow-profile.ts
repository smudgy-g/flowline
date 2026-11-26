// Workflow simulations must not depend on the installing team's base or reviewer count.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "factory-profile-"));
const profile = JSON.parse(readFileSync(new URL("../../examples/go.factory.json", import.meta.url), "utf8"));
profile.skills.codeReviewers = ["architect", "interrogate", "change-impact"];
writeFileSync(join(root, "factory.config.json"), JSON.stringify(profile));
process.env.FACTORY_ROOT = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
