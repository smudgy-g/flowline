// Drives the whole fast lane with fake side effects, through the same run helpers the CLI uses.
// A new factory (Mastra instance) per command, sharing one database file, mirrors one `fx` process per command.
import "./workflow-profile.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ops } from "../src/fast-lane.ts";
import { parseUnfinished, type UatReport } from "../src/rules.ts";
import { card } from "../src/board.ts";
import { createFactory, resume, runIdFor, start, view } from "../src/runs.ts";

/** Where the board shows a run. */
const pick = (c: { column: string; kind: string; status: string } | null) =>
  c && { column: c.column, kind: c.kind, status: c.status };

function fakeWorld() {
  const calls: string[] = [];

  const world = {
    files: ["server/a.ts"],
    digest: "d1",
    gateFailures: 1,
    uatResults: ["client", "passed"] as Array<
      "client" | "passed" | "infrastructure"
    >,
    reviewReplies: [] as string[],
    pushed: "",
    history: [] as string[],
    prompts: [] as string[],
    plannerReply: "no json",
    /** Planner replies used first, in order; then plannerReply. */
    plannerReplies: [] as string[],
    /** Answers review calls by prompt when set (parallel reviewers), else reviewReplies in order. */
    reviewer: undefined as undefined | ((prompt: string) => string | undefined),
    issueBody: "Customers wait forever.",
    issues: [] as string[],
    splits: [] as string[],
    claims: [] as number[],
    /** How many more coder calls edit the worktree (change its fingerprint). */
    coderEdits: Infinity,
    /** The coder's replies, in order; "done" once they run out. */
    coderReplies: [] as string[],
    /** Pause requests: "all" or run ids. */
    pauses: new Set<string>(),
    /** Called after each coder call (a test pauses from here). */
    afterCoder: () => {},
    baselines: [] as string[],
  };

  const clean =
    '```json\n{"findings":[{"severity":"low","file":"a.ts","line":3,"description":"nit"}]}\n```';

  const ops: Ops = {
    paused: async (runId) => world.pauses.has("all") || world.pauses.has(runId),
    readIssue: async (number) => ({
      number,
      title: "Inquiries hang when Slack is down",
      body: world.issueBody,
      url: "u",
      author: "adam",
      comments: [],
    }),
    claim: async (n) => {
      world.claims.push(Number(n));
    },
    branchExists: async () => false,
    uatBaseline: async (at, after) => {
      if (at && after && /^0+$/.test(at)) throw new Error("only forward");

      return at ?? "f".repeat(40);
    },
    provision: async (branch, base) => {
      calls.push(`provision ${branch} on ${base}`);
      return `/wt/${branch}`;
    },
    checkWorktree: async () => {},
    runPi: async (_wt, role, prompt) => {
      world.prompts.push(`${role}: ${prompt}`);

      if (role === "coder" && world.coderEdits-- > 0)
        world.digest = `d${world.prompts.length}`;

      if (role === "coder") world.afterCoder();

      calls.push(
        `pi ${role}${prompt.match(/## This call: (step \d+ of \d+)/)?.[1].replace(/^/, " ") ?? ""}${role === "coder" && prompt.includes("Fix this") ? " (with feedback)" : ""}`,
      );
      return role === "review"
        ? (world.reviewer?.(prompt) ?? world.reviewReplies.shift() ?? clean)
        : role === "planner"
          ? (world.plannerReplies.shift() ?? world.plannerReply)
          : (world.coderReplies.shift() ?? "done");
    },
    inspect: async () => ({ files: world.files, sensitive: [] }),
    fingerprint: async () => world.digest,
    runGates: async () =>
      world.gateFailures-- > 0
        ? { ok: false, gate: "typecheck", output: "TS2322" }
        : { ok: true },
    commitAndPush: async () => {
      calls.push("push");
      world.pushed = `sha${calls.length}`;
      return world.pushed;
    },
    pushedHead: async () => world.pushed,
    runUat: async (branch, baseline) => {
      world.baselines.push(baseline);
      const kind = world.uatResults.shift()!;
      calls.push(`uat ${kind}`);

      if (kind === "infrastructure") throw new Error("Acceptance worker unavailable");

      const report: UatReport = {
        ref: branch,
        commit: world.pushed,
        pass: kind === "passed",
        detail: kind === "client" ? "customer inquiry timed out" : "Passed",
      };

      return { run: "run-x", report };
    },
    openDraftPr: async () => {
      calls.push("pr");
      return "https://github.com/x/pull/1";
    },
    commentOnIssue: async (n, text) => {
      calls.push(`comment #${n} ${text}`);
    },
    record: async (_worktree, title) => {
      world.history.push(title);
    },
    checkSkills: async (_wt, skills) => {
      calls.push(`skills ${skills.length}`);
    },
    createIssue: async (title) => {
      world.issues.push(title);
      return String(2000 + world.issues.length);
    },
    recordSplit: async (base, member, parts) => {
      world.splits.push(`${base} #${member}: ${parts.join(" | ")}`);
    },
  };

  return { ops, calls, world };
}

const plan = {
  summary: "Fail fast when Slack is down",
  tests: "inquiry returns 200 with Slack unreachable",
};

test("fast lane: plan, retry on test failure, approve, UAT replan, draft PR", async () => {
  const { ops, calls, world } = fakeWorld();
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db); // a fresh process per command
  const id = runIdFor("1412");

  let v = await start(fx(), "1412");
  assert.equal(v.waiting?.kind, "plan");
  assert.deepEqual(world.claims, [1412]);
  assert.deepEqual(pick(await card(fx(), id)), {
    column: "Plan",
    kind: "needs",
    status: "Agree a plan",
  });
  await assert.rejects(start(fx(), "1412"), /already has a run/);

  v = await resume(fx(), id, { plan });
  assert.equal(v.waiting?.kind, "plan-approval");
  v = await resume(fx(), id, { approve: true });
  // Implement, typecheck fails, implement again with the failure, tests pass, review clear: outcome gate.
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.equal(v.waiting?.digest, world.digest);

  // The written history: the plan, each round's coder, checks and review, in order.
  assert.deepEqual(world.history, [
    "You approved the plan for 1412: Inquiries hang when Slack is down",
    "Round 1 · coder",
    'Round 1 · checks failed at "typecheck"',
    "Round 2 · coder",
    "Round 2 · checks passed",
    "Round 2 · review: nothing blocking",
  ]);
  assert.deepEqual(pick(await card(fx(), id)), {
    column: "Your OK",
    kind: "needs",
    status: "Approve the change",
  });
  assert.deepEqual(calls.slice(0, 6), [
    "provision 1412-inquiries-hang-slack-down on main",
    "pi planner",
    "pi planner",
    "pi coder",
    "pi coder (with feedback)",
    "pi review",
  ]);

  // An edit while the gate waits invalidates the approval (FEEDBACK 24).
  world.digest = "d2";
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "changed");
  v = await resume(fx(), id, { reject: "someone edited it" });
  // Back through implement → test → review; the approval is asked for what was tested.
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.equal(v.waiting?.digest, world.digest);
  v = await resume(fx(), id, { approve: true });
  // Pushed, UAT failed on a journey: back to plan with the failure.
  assert.equal(v.waiting?.kind, "plan");
  assert.match(v.waiting!.message, /customer inquiry/);

  v = await resume(fx(), id, { plan });
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.status, "success");
  assert.equal(v.prUrl, "https://github.com/x/pull/1");
  assert.deepEqual(pick(await card(fx(), id)), {
    column: "Draft PR",
    kind: "done",
    status: "Draft PR open",
  });
  assert.deepEqual(calls.slice(-4), [
    "push",
    "uat passed",
    "pr",
    "comment #1412 Draft PR: https://github.com/x/pull/1",
  ]);
});

test("fast lane: infrastructure failure waits in UAT and retries; unparseable review asks the driver", async () => {
  const { ops, calls, world } = fakeWorld();
  world.gateFailures = 0;
  world.uatResults = ["infrastructure", "passed"];
  world.reviewReplies = ["looks fine to me", "still no block"]; // the review, then its reformat
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("7");

  await start(fx(), "7");
  await resume(fx(), id, { plan });
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "findings");
  v = await resume(fx(), id, {
    findings: [
      { severity: "high", file: "a.ts", line: 1, description: "null deref" },
    ],
  });
  // Blocking finding: implement again with it, then the default (clean) review.
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.ok(calls.includes("pi coder (with feedback)"));
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "error");
  assert.equal(v.waiting?.step, "uat");
  assert.deepEqual(pick(await card(fx(), id)), {
    column: "UAT",
    kind: "stuck",
    status: "A step failed",
  });
  v = await resume(fx(), id, { retry: true });
  assert.equal(v.status, "success");
  assert.equal((await view(fx(), id))?.prUrl, "https://github.com/x/pull/1");
});

test("a stack member builds on its stack branch; anything else is refused", async () => {
  const { ops, calls } = fakeWorld();
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  await start(fx(), "1500", "stack/portal-dashboard");
  await resume(fx(), runIdFor("1500"), { plan });
  await resume(fx(), runIdFor("1500"), { approve: true });
  assert.equal(
    calls[0],
    "provision 1500-inquiries-hang-slack-down on stack/portal-dashboard",
  );
  const bad = await start(fx(), "1501", "--upload-pack=x").catch((e) => e);
  assert.ok(
    bad instanceof Error || bad.status === "failed",
    "a base that is not the configured base or stack/<name> must not run",
  );
  assert.ok(!calls.some((c) => c.includes("1501")));
});

test("a coder round that changes nothing stops with its reply instead of testing", async () => {
  const { ops, calls, world } = fakeWorld();
  world.gateFailures = 0;
  world.files = [];
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("8");
  await start(fx(), "8");
  await resume(fx(), id, { plan });
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "no-change");
  assert.equal(v.waiting?.reply, "done");
  assert.equal((await card(fx(), id))?.lane?.coderReply, "done");
  assert.deepEqual(pick(await card(fx(), id)), {
    column: "Code",
    kind: "stuck",
    status: "The coder changed nothing",
  });
  world.files = ["server/a.ts"];
  v = await resume(fx(), id, { retry: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.equal(calls.filter((c) => c === "pi coder").length, 2);
});

test("a coder that is blocked after earlier rounds stops; --proceed and --baseline take the change to UAT as it is", async () => {
  const { ops, calls, world } = fakeWorld();
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("10");
  await start(fx(), "10");
  await resume(fx(), id, { plan });
  // Round 1 fails a gate; in round 2 the coder edits nothing, though the branch still has round 1's files.
  world.coderEdits = 1;
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "no-change");
  assert.equal(calls.filter((c) => c === "pi coder (with feedback)").length, 1);
  const coderCalls = calls.filter((c) => c.startsWith("pi coder")).length;
  const bad = await resume(fx(), id, { retry: true, proceed: true, baseline: "0".repeat(40) });
  assert.equal(bad.waiting?.kind, "error", "UAT inputs never move backwards");
  v = await resume(fx(), id, { retry: true, proceed: true, baseline: "a".repeat(40), note: "the journey was stale" });
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.equal(calls.filter((c) => c.startsWith("pi coder")).length, coderCalls, "no coder round");
  assert.ok(world.history.includes("You moved the UAT inputs forward"));
  world.uatResults = ["passed"];
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.status, "success");
  assert.deepEqual(world.baselines, ["a".repeat(40)]);
});

test("after a UAT failure on a stale journey, approving with --baseline moves UAT onto the fixed one", async () => {
  const { ops, world } = fakeWorld();
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("11");
  await start(fx(), "11");
  await resume(fx(), id, { plan });
  await resume(fx(), id, { approve: true });
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "plan", "UAT failed on the journey the run started with");

  await resume(fx(), id, { plan });
  v = await resume(fx(), id, { approve: true, baseline: "a".repeat(40) });
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.ok(world.history.includes("You moved the UAT inputs forward"));
  // The outcome approval can move it again, still forward only.
  v = await resume(fx(), id, { approve: true, baseline: "b".repeat(40) });
  assert.equal(v.status, "success");
  assert.deepEqual(world.baselines, ["f".repeat(40), "b".repeat(40)]);
});

test("a numbered plan goes to the coder one step per call, then once whole; later rounds only once", async () => {
  const { ops, calls } = fakeWorld();
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("9");
  await start(fx(), "9");
  await resume(fx(), id, {
    plan: {
      summary:
        "Intro.\n\n1. Move the schema.\n- detail\n2. Add the route.\n\nNotes after.",
      tests: "t",
    },
  });
  const v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  // Round 1 (typecheck fails), then round 2 with the failure only.
  assert.deepEqual(
    calls.filter((c) => c.startsWith("pi coder")),
    [
      "pi coder step 1 of 2",
      "pi coder step 2 of 2",
      "pi coder",
      "pi coder (with feedback)",
    ],
  );
});

test("steps the whole-plan call leaves unfinished each get their own call in the same round", async () => {
  const { ops, calls, world } = fakeWorld();
  world.coderReplies = ["step 1 done", "step 2 too big", "step 3 done", "Steps 2 and 3 are missing.\nUnfinished steps: 3, 2, 9"];
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("12");
  await start(fx(), "12");
  await resume(fx(), id, {
    plan: { summary: "1. Schema.\n2. Route.\n3. Page.", tests: "t" },
  });
  const v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  // Round 1: each step, the whole plan, then the unfinished steps in order; round 2 (typecheck failed): whole only.
  assert.deepEqual(
    calls.filter((c) => c.startsWith("pi coder")),
    [
      "pi coder step 1 of 3",
      "pi coder step 2 of 3",
      "pi coder step 3 of 3",
      "pi coder",
      "pi coder step 2 of 3",
      "pi coder step 3 of 3",
      "pi coder (with feedback)",
    ],
  );
  assert.ok(world.history.includes("Round 1 · coder, step 2 of 3 again"));
  assert.deepEqual(parseUnfinished("Unfinished steps: none", 3), []);
  assert.deepEqual(parseUnfinished("**Unfinished steps:** 1, 1", 3), [1]);
  assert.deepEqual(parseUnfinished("no line", 3), []);
});

test("a pause stops a run between coder calls and before its next step; resuming carries on", async () => {
  const { ops, calls, world } = fakeWorld();
  world.gateFailures = 0;
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("13");
  await start(fx(), "13");
  await resume(fx(), id, {
    plan: { summary: "1. Schema.\n2. Route.\n3. Page.", tests: "t" },
  });
  // Pausing all while it waits for a person: their answer still goes through, then it stops.
  world.pauses.add("all");
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "paused");
  assert.equal(calls.filter((c) => c.startsWith("pi coder")).length, 0);

  // Resumed, it starts coding; paused after step 1, it stops before step 2.
  world.pauses.clear();

  world.afterCoder = () => {
    world.pauses.add(id);

    world.afterCoder = () => {};
  };

  v = await resume(fx(), id, {});
  assert.equal(v.waiting?.kind, "paused");
  assert.deepEqual(calls.filter((c) => c.startsWith("pi coder")), ["pi coder step 1 of 3"]);

  // Resumed again, it goes on from step 2, not from the start, and not as a retry.
  world.pauses.clear();
  v = await resume(fx(), id, {});
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.deepEqual(calls.filter((c) => c.startsWith("pi coder")), [
    "pi coder step 1 of 3",
    "pi coder step 2 of 3",
    "pi coder step 3 of 3",
    "pi coder",
  ]);
});

test("a plan without numbered steps is split by the planner; an unusable split leaves it one call", async () => {
  const { ops, calls, world } = fakeWorld();
  world.gateFailures = 0;
  world.plannerReply =
    'Read the code.\n```json\n{"steps":["Move the schema in a.ts","2. Add the route b.ts"]}\n```';
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  await start(fx(), "10");
  await resume(fx(), runIdFor("10"), {
    plan: { summary: "A spec, pasted as is.", tests: "t" },
  });
  await resume(fx(), runIdFor("10"), { approve: true });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("pi coder") || c === "pi planner"),
    [
      "pi planner",
      "pi planner",
      "pi coder step 1 of 2",
      "pi coder step 2 of 2",
      "pi coder",
    ],
  );
  assert.deepEqual((await card(fx(), runIdFor("10")))?.lane?.steps, [
    "1. Move the schema in a.ts",
    "2. Add the route b.ts",
  ]);

  calls.length = 0;
  world.plannerReply = "no json";
  await start(fx(), "11");
  await resume(fx(), runIdFor("11"), {
    plan: { summary: "Another spec.", tests: "t" },
  });
  await resume(fx(), runIdFor("11"), { approve: true });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("pi coder") || c === "pi planner"),
    ["pi planner", "pi planner", "pi coder"],
  );
});

test("a send-back is a decision: later coders and reviewers get it, and its rounds start fresh", async () => {
  const { ops, world } = fakeWorld();
  world.gateFailures = 0;
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("12");

  await start(fx(), "12");
  await resume(fx(), id, { plan });
  let v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");

  world.prompts.length = 0;
  v = await resume(fx(), id, { reject: "Drop the page limit" });
  assert.equal(v.waiting?.kind, "outcome-approval");

  const review = world.prompts.find((p) => p.startsWith("review: "))!;
  assert.match(review, /human's decisions[\s\S]*1\. Drop the page limit/);
  assert.match(
    world.prompts.find((p) => p.startsWith("coder: "))!,
    /1\. Drop the page limit/,
  );
  assert.equal((await card(fx(), id))?.lane?.cycles, 1);
});

test("the planner drafts the plan from the issue; the card asks to approve it, with its questions", async () => {
  const { ops, world } = fakeWorld();
  world.plannerReply =
    'Read it.\n```json\n{"summary":"1. Fail fast.\\n2. Log it.","tests":"inquiry returns 200","questions":["Retry Slack later? Default: no."]}\n```';
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);

  const v = await start(fx(), "13");

  assert.equal(v.waiting?.kind, "plan-approval");
  assert.deepEqual(v.waiting?.plan, {
    summary: "1. Fail fast.\n2. Log it.",
    tests: "inquiry returns 200",
  });
  assert.deepEqual(v.waiting?.questions, ["Retry Slack later? Default: no."]);
  assert.equal(world.history[0], "The planner drafted a plan");
});

const json = (findings: object[]) =>
  "```json\n" + JSON.stringify({ findings }) + "\n```";

const high = (description: string) => ({
  severity: "high",
  file: "issue",
  line: 0,
  description,
});

const planReply = (n: number) =>
  "```json\n" +
  JSON.stringify({
    summary: `Scope ${n}\n1. step a\n2. step b`,
    tests: "inquiry test",
    questions: [],
  }) +
  "\n```";

test("standard: every plan reviewed, at most two automatic revisions, then it waits with what's open; wider code review", async () => {
  const { ops, calls, world } = fakeWorld();
  world.issueBody = "### Outcome\n\nFail fast\n\n### Lane\n\nstandard";
  world.gateFailures = 0;
  world.plannerReplies = [planReply(1), planReply(2), planReply(3)];
  let architectRounds = 0;

  world.reviewer = (prompt) => {
    if (prompt.includes("drafted plan"))
      return prompt.includes("/skill:plan-fitness")
        ? `${json([high("no step handles Slack timing out")])}\n\nProposed PRs:\n1. Fail fast: inquiry route\n2. Retry later: queue`
        : json([]);

    if (prompt.includes("/skill:interrogate")) return "no block here";

    if (prompt.startsWith("A code reviewer wrote") && prompt.includes("no block here"))
      return "still none";

    if (prompt.includes("/skill:architect"))
      return architectRounds++ ? json([]) : json([high("logic belongs in the service")]);

    return undefined;
  };

  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("1500");

  let v = await start(fx(), "1500");
  assert.equal(v.waiting?.kind, "plan-approval");
  assert.ok(calls.includes("skills 6"));
  assert.equal(calls.filter((c) => c === "pi planner").length, 3);
  assert.equal(calls.filter((c) => c === "pi review").length, 12);
  assert.match((v.waiting!.plan as { summary: string }).summary, /Scope 3/);
  assert.deepEqual(
    (v.waiting!.findings as Array<{ description: string }>).map((f) => f.description),
    ["[plan-fitness] no step handles Slack timing out"],
  );
  assert.deepEqual(v.waiting!.proposedPrs, ["Fail fast: inquiry route", "Retry later: queue"]);
  assert.ok(world.prompts.some((p) => p.startsWith("planner:") && p.includes("What the plan reviewers found")));
  assert.deepEqual(
    world.history.filter((h) => h.startsWith("Plan review") || h.startsWith("The planner revised")),
    [
      "Plan review: 1 to address",
      "The planner revised the plan (revision 1)",
      "Plan review of revision 1: 1 to address",
      "The planner revised the plan (revision 2)",
      "Plan review of revision 2: 1 to address",
    ],
  );

  // Approved with the finding open: coding goes on. The architect's blocking finding goes to the coder; the
  // reviewer with no parseable findings is skipped.
  v = await resume(fx(), id, { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.ok(world.history.includes("Round 1 · review: 1 blocking"));
  assert.ok(world.history.includes("Round 1 · skipped reviewers"));
  assert.ok(world.history.includes("Round 2 · review: nothing blocking"));
  assert.ok(
    world.prompts.some((p) => p.startsWith("coder:") && p.includes("[architect] logic belongs in the service")),
  );
  // Two review rounds of four reviewers, plus the unparseable one asked again each round.
  assert.equal(
    world.prompts.filter((p) => p.startsWith("review:") && !p.includes("drafted plan")).length,
    10,
  );
});

test("a fast-lane issue gets no plan review and one code reviewer", async () => {
  const { ops, calls, world } = fakeWorld();
  world.plannerReply = planReply(1);
  world.gateFailures = 0;
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  let v = await start(fx(), "1501");
  assert.equal(v.waiting?.kind, "plan-approval");
  assert.equal(v.waiting?.findings, undefined);
  v = await resume(fx(), runIdFor("1501"), { approve: true });
  assert.equal(v.waiting?.kind, "outcome-approval");
  assert.equal(calls.filter((c) => c === "pi review").length, 1);
  assert.ok(!calls.some((c) => c.startsWith("skills")));
});

test("split at plan approval: this run keeps the first part; the rest become issues once, or a stack's split", async () => {
  const { ops, calls, world } = fakeWorld();
  world.plannerReply = planReply(1);
  const db = `file:${join(mkdtempSync(join(tmpdir(), "fx-")), "factory.db")}`;
  const fx = () => createFactory(ops, db);
  const id = runIdFor("1502");

  await start(fx(), "1502");
  let v = await resume(fx(), id, { split: ["Fail fast: route", "Retry later: queue", "Alert: Slack"] });
  assert.equal(v.waiting?.kind, "plan-approval");
  assert.equal(v.waiting?.scope, "Fail fast: route");
  assert.deepEqual(world.issues, ["Retry later", "Alert"]);
  assert.ok(calls.includes("comment #1502 Split into 3 PRs. This one: Fail fast: route. The rest: #2001, #2002."));
  assert.ok(world.prompts.at(-1)!.includes("This PR is only part of the issue\nThe issue was split"));
  // A send-back replans the same part and creates nothing again.
  v = await resume(fx(), id, { reject: "smaller" });
  assert.equal(world.issues.length, 2);
  assert.ok(world.prompts.at(-1)!.includes("Fail fast: route"));

  // A stack member's split is handed to the stack instead.
  await start(fx(), "1503", "stack/1400-offers");
  await resume(fx(), runIdFor("1503"), { split: ["Read offers", "Review offers"] });
  assert.deepEqual(world.splits, ["stack/1400-offers #1503: Review offers"]);
  assert.equal(world.issues.length, 2);
});
