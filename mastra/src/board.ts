// The board: every run as a card in the column of the stage it is at, with what it needs from you.
// Served by `mastra dev` at http://localhost:4111/board (the page is board.html); `factory-ui` opens it.
//
// Every action carries the token of the wait it was shown, so a click only applies to what was on screen.
// Like `fx approve`, this guards against mistakes, not against an agent with a shell in the VM (README.md).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { registerApiRoute } from "@mastra/core/server";
import type { LaneState } from "./fast-lane.ts";
import {
  branchDiff,
  closeIssue,
  factoryIssues,
  factoryName,
  factoryRoot,
  newerUatInputs,
  releaseIssue,
  checksLog,
  historyFile,
  paused,
  pauseRequests,
  prState,
  removeTask,
  setPaused,
  syncLog,
  syncVm,
} from "./ops.ts";
import { sha256 } from "./rules.ts";
import type { StackState } from "./stack.ts";
import {
  forget,
  laneState,
  list,
  resumable,
  resume,
  runIdFor,
  stackState,
  start,
  startStack,
  view,
  type Factory,
  type ResumeData,
  type RunView,
} from "./runs.ts";

export const COLUMNS = [
  "Issues",
  "Stacks",
  "Plan",
  "Code",
  "Tests",
  "Review",
  "Your OK",
  "UAT",
  "Draft PR",
] as const;
type Column = (typeof COLUMNS)[number];

const STEPS: Record<string, { column: Column; doing: string }> = {
  intake: { column: "Plan", doing: "Reading the issue" },
  plan: { column: "Plan", doing: "Planning" },
  provision: { column: "Code", doing: "Setting up the worktree" },
  implement: { column: "Code", doing: "Coding" },
  test: { column: "Tests", doing: "Running checks and tests" },
  review: { column: "Review", doing: "Reviewing" },
  outcome: { column: "Your OK", doing: "Checking the change" },
  prepare: { column: "UAT", doing: "Pushing the branch" },
  uat: { column: "UAT", doing: "Running UAT" },
  "draft-pr": { column: "Draft PR", doing: "Opening the draft PR" },
};
/** Waits that are a person's decision; every other wait means something went wrong. */
const ASKS: Record<string, string> = {
  plan: "Agree a plan",
  "plan-approval": "Approve the plan",
  "outcome-approval": "Approve the change",
  design: "Agree the design",
  "design-approval": "Approve the design",
  "by-hand": "Do a step by hand",
};
const STUCK: Record<string, string> = {
  paused: "Paused",
  error: "A step failed",
  changed: "Files changed after testing",
  "no-change": "The coder changed nothing",
  "cycle-limit": "Too many build rounds",
  findings: "Couldn't read the review",
};

export type Card = {
  issue: number;
  title: string;
  url?: string;
  column: Column;
  kind: "needs" | "running" | "stuck" | "done" | "paused";
  /** A pause was asked for this run, or for all: a running one stops before its next step. */
  pauseRequested?: boolean;
  status: string;
  since?: number;
  token?: string;
  /** A step is executing in this server right now (a deploy would kill it); a stack waiting on its member is not. */
  executing?: boolean;
  waiting?: RunView["waiting"];
  error?: string;
  prUrl?: string;
  merged?: boolean;
  /** At an approval: the factory's UAT journeys changed since this run's were pinned. */
  newerUat?: { head: string; files: string[] };
  /** Runs in the standard lane: plan review and the wider code review. */
  standard?: boolean;
  lane?: Pick<
    LaneState,
    | "workItem"
    | "base"
    | "plan"
    | "steps"
    | "stepsDone"
    | "cycles"
    | "lowNotes"
    | "uatRun"
    | "uatReport"
    | "coderReply"
  > & { issueBody?: string; history?: string };
  stack?: Pick<StackState, "branch" | "members" | "design" | "current"> & {
    issueBody?: string;
  };
};

/** A stack lives in the Stacks column; its members are ordinary cards in the stage columns. */
async function stackCard(factory: Factory, v: RunView): Promise<Card> {
  const s = await stackState(factory, v.runId);
  const base = {
    issue: Number(v.runId.replace("issue-", "")),
    title: s?.issue?.title ?? v.runId,
    url: s?.issue?.url,
    since: v.since,
    column: "Stacks" as Column,
    standard: s?.lane === "standard" || undefined,
    stack: s
      ? {
          branch: s.branch,
          members: s.members,
          design: s.design,
          current: s.current,
          issueBody: s.issue?.body,
        }
      : undefined,
  };
  const total = s?.members.length ?? 0;
  if (v.waiting?.kind === "member-running")
    return {
      ...base,
      kind: "running",
      status: `PR ${Number(v.waiting.index) + 1} of ${total}: #${v.waiting.number}`,
      waiting: v.waiting,
      token: tokenOf(v.waiting),
    };
  if (v.waiting) {
    const ask = ASKS[v.waiting.kind];
    return {
      ...base,
      kind: ask ? "needs" : v.waiting.kind === "paused" ? "paused" : "stuck",
      status: ask ?? STUCK[v.waiting.kind] ?? "Stopped",
      waiting: v.waiting,
      token: tokenOf(v.waiting),
    };
  }
  if (v.status === "success")
    return {
      ...base,
      kind: "done",
      status: "Draft PR to staging open",
      prUrl: v.prUrl,
    };
  if (v.status === "running")
    return { ...base, kind: "running", status: "Working…" };
  return { ...base, kind: "stuck", status: `Run ${v.status}`, error: v.error };
}

/** The end of the work item's written history: enough for the card, the whole file is in the worktree. */
async function historyTail(worktree: string): Promise<string | undefined> {
  const text = await readFile(historyFile(worktree), "utf8").catch(() => "");

  return text ? text.slice(-12000) : undefined;
}

const tokenOf = (waiting: RunView["waiting"]) =>
  sha256(JSON.stringify(waiting));

export async function card(
  factory: Factory,
  runId: string,
): Promise<Card | null> {
  const [v, lane] = await Promise.all([
    view(factory, runId),
    laneState(factory, runId),
  ]);
  if (!v) return null;
  if (v.workflow === "stack") return stackCard(factory, v);
  const step = STEPS[v.step ?? ""] ?? STEPS.intake;
  const base = {
    issue: Number(runId.replace("issue-", "")),
    title: lane?.issue?.title ?? runId,
    url: lane?.issue?.url,
    since: v.since,
    standard: lane?.lane === "standard" || undefined,
    lane: lane
      ? {
          workItem: lane.workItem,
          base: lane.base,
          plan: lane.plan,
          steps: lane.steps,
          stepsDone: lane.stepsDone,
          cycles: lane.cycles,
          coderReply: lane.coderReply,
          lowNotes: lane.lowNotes,
          uatRun: lane.uatRun,
          uatReport: lane.uatReport,
          issueBody: lane.issue?.body,
          history: lane.worktree ? await historyTail(lane.worktree) : undefined,
        }
      : undefined,
  };
  if (v.waiting) {
    const ask = ASKS[v.waiting.kind];
    return {
      ...base,
      column: step.column,
      kind: ask ? "needs" : v.waiting.kind === "paused" ? "paused" : "stuck",
      status: ask ?? STUCK[v.waiting.kind] ?? "Stopped",
      waiting: v.waiting,
      token: tokenOf(v.waiting),
      newerUat:
        APPROVALS.includes(v.waiting.kind) && lane?.baseline
          ? // A hint only: a baseline git can't read just hides the button.
            ((await newerUatInputs(lane.baseline).catch(() => null)) ??
            undefined)
          : undefined,
    };
  }
  if (v.status === "success")
    return {
      ...base,
      column: "Draft PR",
      kind: "done",
      status: "Draft PR open",
      prUrl: v.prUrl,
    };
  if (v.status === "running")
    return {
      ...base,
      column: step.column,
      kind: "running",
      status: step.doing,
    };
  return {
    ...base,
    column: step.column,
    kind: "stuck",
    status: `Run ${v.status}`,
    error: v.error,
  };
}

const APPROVALS = ["plan-approval", "outcome-approval"];

/** Which buttons each wait offers, and the resume data each sends. */
function resumeDataFor(
  kind: string,
  body: {
    action?: string;
    why?: string;
    summary?: string;
    tests?: string;
    design?: string;
    parts?: string;
    baseline?: string;
  },
): ResumeData {
  const decision =
    kind === "plan-approval" ||
    kind === "outcome-approval" ||
    kind === "design-approval";
  if (body.action === "approve" && (decision || kind === "by-hand"))
    return { approve: true };
  if (body.action === "approve-latest-uat" && APPROVALS.includes(kind)) {
    if (!body.baseline) throw new Error("Which factory commit's journeys?");
    return { approve: true, baseline: body.baseline };
  }
  if (body.action === "approve-proposed" && kind === "design-approval")
    return { approve: true, useProposed: true };
  const parts = (body.parts ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  if (body.action === "split" && kind === "plan-approval") {
    if (parts.length < 2)
      throw new Error("A split needs at least two PRs, one per line");
    return { split: parts };
  }
  if (
    body.action === "reject" &&
    (decision || kind === "changed") &&
    body.why?.trim()
  )
    return { reject: body.why.trim() };
  if (body.action === "proceed" && kind === "no-change")
    return { retry: true, proceed: true };
  if (
    body.action === "retry" &&
    [
      "error",
      "changed",
      "cycle-limit",
      "no-change",
      "member-running",
      "findings",
    ].includes(kind)
  )
    return body.why?.trim()
      ? { retry: true, note: body.why.trim() }
      : { retry: true };
  if (
    body.action === "plan" &&
    kind === "plan" &&
    body.summary?.trim() &&
    body.tests?.trim()
  )
    return { plan: { summary: body.summary.trim(), tests: body.tests.trim() } };
  if (body.action === "design" && kind === "design" && body.design?.trim())
    return { design: body.design.trim() };
  throw new Error(
    `Can't ${body.action ?? "do that"} here${body.action === "reject" ? " without saying why" : ""}`,
  );
}

export function boardRoutes(factory: () => Factory) {
  /** Runs this server is resuming right now, so a double click can't resume one twice. */
  const busy = new Set<string>();
  const inBackground = (runId: string, work: () => Promise<unknown>) => {
    busy.add(runId);
    work()
      .catch((error) => console.error(`board: ${runId}:`, error))
      .finally(() => busy.delete(runId));
  };
  /** PR states from GitHub, looked up at most once a minute each. */
  const prCache = new Map<string, { at: number; state: Promise<string> }>();
  const cachedPrState = (url: string) => {
    const hit = prCache.get(url);
    if (hit && Date.now() - hit.at < 60_000) return hit.state;
    const state = prState(url).catch(() => "");
    prCache.set(url, { at: Date.now(), state });
    return state;
  };
  let issues = {
    at: 0,
    list: [] as Array<{
      number: number;
      title: string;
      url: string;
      stack: boolean;
    }>,
    error: "",
  };
  const issueNumber = (raw: string) => {
    const issue = Number(raw);
    if (!Number.isInteger(issue) || issue <= 0)
      throw new Error(`Not an issue number: ${raw}`);
    return issue;
  };

  let syncing = false;
  /** When each half of the sync last finished (vm/sync.sh writes laptop-synced, sync-in-vm.sh vm-synced). */
  const stamp = (name: string) =>
    readFile(`${homedir()}/.cache/factory/${name}`, "utf8").then(
      (s) => s.trim(),
      () => "",
    );

  return [
    registerApiRoute("/board", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) =>
        c.html(await readFile(`${factoryRoot}/mastra/src/board.html`, "utf8")),
    }),

    registerApiRoute("/board/data", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) => {
        const runs = await list(factory());
        const cards = (
          await Promise.all(runs.map((r) => card(factory(), r.runId)))
        ).filter((x): x is Card => x !== null);
        for (const c of cards)
          c.executing =
            runs.find((r) => r.runId === runIdFor(c.issue))?.status ===
              "running" || busy.has(runIdFor(c.issue));
        for (const c of cards)
          if (busy.has(runIdFor(c.issue)) && c.kind !== "running")
            Object.assign(c, {
              kind: "running",
              status: "Working…",
              token: undefined,
            });
        const pauses = await pauseRequests();
        const allPaused = pauses.includes("all");
        for (const c of cards)
          if (allPaused || pauses.includes(runIdFor(c.issue))) {
            c.pauseRequested = true;
            if (c.kind === "running") c.status += " · pausing after this";
          }
        for (const c of cards)
          if (c.kind === "done" && c.prUrl) {
            const state = await cachedPrState(c.prUrl);
            if (state === "MERGED")
              Object.assign(c, {
                merged: true,
                status: "Merged · ready to clean up",
              });
            if (state === "CLOSED")
              Object.assign(c, { status: "PR closed without merging" });
          }
        if (Date.now() - issues.at > 60_000) {
          issues = await factoryIssues().then(
            (list) => ({ at: Date.now(), list, error: "" }),
            (e: Error) => ({ at: Date.now(), list: [], error: e.message }),
          );
        }
        const waiting = issues.list
          .filter((i) => !cards.some((c) => c.issue === i.number))
          .map((i) => ({
            issue: i.number,
            title: i.title,
            url: i.url,
            column: "Issues",
            stack: i.stack || undefined,
            kind: busy.has(runIdFor(i.number)) ? "running" : "idle",
            status: busy.has(runIdFor(i.number))
              ? "Starting…"
              : i.stack
                ? "Stack · not started"
                : "Not started",
          }));
        return c.json({
          factory: factoryName,
          columns: COLUMNS,
          cards: [...waiting, ...cards],
          allPaused,
          issuesError: issues.error,
        });
      },
    }),

    registerApiRoute("/board/sync", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) =>
        c.json({
          running: syncing,
          laptop: await stamp("laptop-synced"),
          vm: await stamp("vm-synced"),
          log: (await readFile(syncLog, "utf8").catch(() => ""))
            .split("\n")
            .slice(-40)
            .join("\n"),
        }),
    }),

    // The VM half only: GitHub fetches and the board's own code. Laptop files only travel when factory-ui runs vm/sync.sh.
    registerApiRoute("/board/sync", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        if (syncing) return c.json({ error: "Already syncing" }, 409);
        syncing = true;
        syncVm().on("exit", () => {
          syncing = false;
        });
        return c.json({ ok: true }, 202);
      },
    }),

    registerApiRoute("/board/diff/:issue", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) => {
        const lane = await laneState(
          factory(),
          runIdFor(issueNumber(c.req.param("issue"))),
        );
        if (!lane?.worktree) return c.text("No worktree yet", 404);
        return c.text(await branchDiff(lane.worktree));
      },
    }),

    registerApiRoute("/board/log/:issue", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) => {
        const lane = await laneState(
          factory(),
          runIdFor(issueNumber(c.req.param("issue"))),
        );
        const text = lane?.workItem
          ? await readFile(checksLog(lane.worktree), "utf8").catch(() =>
              // Runs from before the log moved into the worktree.
              readFile(
                `${factoryRoot}/mastra/.data/logs/${lane.workItem}.log`,
                "utf8",
              ).catch(() => ""),
            )
          : "";
        // The last lines, without terminal colours: enough to see what a step is doing or where it hangs.
        return c.text(
          text
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .slice(-60)
            .join("\n"),
        );
      },
    }),

    registerApiRoute("/board/start/:issue", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const issue = issueNumber(c.req.param("issue"));
        const runId = runIdFor(issue);
        if (busy.has(runId) || (await view(factory(), runId)))
          return c.json({ error: `#${issue} already has a run` }, 409);
        const stack = issues.list.find((i) => i.number === issue)?.stack;
        inBackground(runId, () =>
          stack ? startStack(factory(), issue) : start(factory(), issue),
        );
        return c.json({ ok: true }, 202);
      },
    }),

    // Clean up a merged task, or abandon any task that isn't running: remove its worktree and branch, forget the run.
    registerApiRoute("/board/cleanup/:issue", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const issue = issueNumber(c.req.param("issue"));
        const runId = runIdFor(issue);
        const { abandon } = await c.req.json<{ abandon?: boolean }>();
        const [v, lane] = await Promise.all([
          view(factory(), runId),
          laneState(factory(), runId),
        ]);
        if (!v || busy.has(runId) || v.status === "running")
          return c.json(
            { error: "It is still working; wait until it stops." },
            409,
          );
        const merged =
          v.status === "success" &&
          !!v.prUrl &&
          (await prState(v.prUrl)) === "MERGED";
        if (!merged && !abandon)
          return c.json({ error: "The PR is not merged yet." }, 409);
        busy.add(runId);
        try {
          if (lane?.worktree && lane.workItem)
            await removeTask(lane.worktree, lane.workItem, !!abandon);
          if (merged) await closeIssue(issue, `Merged in ${v.prUrl}`);
          else await releaseIssue(issue).catch(() => {}); // a run from before claims has no label
          await forget(factory(), runId);
        } catch (error) {
          return c.json({ error: (error as Error).message }, 500);
        } finally {
          busy.delete(runId);
        }
        // A stack waiting on this member moves on to its next one.
        for (const r of await list(factory())) {
          if (
            r.workflow === "stack" &&
            r.waiting?.kind === "member-running" &&
            r.waiting.number === issue &&
            !busy.has(r.runId)
          )
            inBackground(r.runId, () =>
              resume(factory(), r.runId, { retry: true }),
            );
        }
        return c.json({ ok: true });
      },
    }),

    // Pause asks a run (or all) to stop before its next step; resume lifts that and wakes whatever it stopped.
    registerApiRoute("/board/pause/:target", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const raw = c.req.param("target");
        const { on } = await c.req.json<{ on?: boolean }>();
        try {
          const target = raw === "all" ? "all" : runIdFor(issueNumber(raw));
          await setPaused(target, !!on);
          if (!on)
            for (const runId of await resumable(factory(), target, paused))
              if (!busy.has(runId))
                inBackground(runId, () => resume(factory(), runId, {}));
        } catch (error) {
          return c.json({ error: (error as Error).message }, 400);
        }
        return c.json({ ok: true });
      },
    }),

    registerApiRoute("/board/act/:issue", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const runId = runIdFor(issueNumber(c.req.param("issue")));
        const body = await c.req.json<{
          token?: string;
          action?: string;
          why?: string;
          summary?: string;
          tests?: string;
          design?: string;
          parts?: string;
          baseline?: string;
        }>();
        const v = await view(factory(), runId);
        if (busy.has(runId) || !v?.waiting || tokenOf(v.waiting) !== body.token)
          return c.json(
            { error: "This changed since you opened it. Have another look." },
            409,
          );
        let data: ResumeData;
        try {
          data = resumeDataFor(v.waiting.kind, body);
        } catch (error) {
          return c.json({ error: (error as Error).message }, 400);
        }
        inBackground(runId, () => resume(factory(), runId, data));
        return c.json({ ok: true }, 202);
      },
    }),
  ];
}
