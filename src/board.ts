// The board: every run as a card in the column of the stage it is at, with what it needs from you.
// Served by `frankenstein board` at http://localhost:4111/board (assets are in board/).
//
// Every action carries the token of the wait it was shown, so a click only applies to what was on screen.
// Like `frankenstein approve`, this guards against mistakes, not against an agent with a shell in the VM (README.md).
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from 'node:path';
import { githubRepo, openLocalPr, prInNote } from './local-pr.ts';
import { registerApiRoute } from "@mastra/core/server";
import type { LaneState } from "./fast-lane.ts";
import {
  branchDiff,
  closeIssue,
  factoryIssues,
  factoryName,
  installRoot,
  stateRoot,
  newerUatInputs,
  releaseIssue,
  checksLog,
  historyFile,
  paused,
  pauseRequests,
  prepareSandbox,
  ownsWorktree,
  prState,
  removeTask,
  setPaused,
} from "./ops.ts";
import { sandbox } from './sandbox.ts';
import { sha256 } from "./rules.ts";
import { config } from "./config.ts";
import { ItemId, tracker } from "./tracker.ts";
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

const githubRemote = (() => {
  try { return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: config.checkout, encoding: 'utf8' }).trim(); }
  catch { return ''; }
})();

export const COLUMNS = [
  "Items",
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
  issue: string;
  title: string;
  url?: string;
  column: Column;
  kind: "needs" | "running" | "stuck" | "done" | "paused";
  /** A pause was asked for this run, or for all: a running one stops before its next step. */
  pauseRequested?: boolean;
  status: string;
  since?: number;
  token?: string;
  sandbox?: string;
  /** A step is executing in this server right now (a deploy would kill it); a stack waiting on its member is not. */
  executing?: boolean;
  waiting?: RunView["waiting"];
  error?: string;
  prUrl?: string;
  githubRepo?: string;
  githubPrUrl?: string;
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
    issue: v.runId.replace("item-", ""),
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
      status: `Draft PR to ${config.base} open`,
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
    issue: runId.replace("item-", ""),
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

  if (v.status === "success") {
    const repo = v.prUrl?.startsWith('file://') && lane?.workItem ? githubRepo(githubRemote) : undefined;

    const note = repo && lane?.workItem
      ? await readFile(join(config.checkout, '.factory/delivered', `${lane.workItem}.md`), 'utf8').catch(() => '')
      : '';

    return {
      ...base,
      column: "Draft PR",
      kind: "done",
      status: v.prUrl?.startsWith('file://') ? 'Change delivered' : 'Draft PR open',
      prUrl: v.prUrl,
      githubRepo: repo,
      githubPrUrl: repo ? prInNote(note, repo) : undefined,
    };
  }

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
      number: string;
      title: string;
      url: string;
      stack: boolean;
    }>,
    error: "",
  };

  const itemId = (raw: string) => ItemId.parse(raw);

  return [
    registerApiRoute("/board", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) =>
        c.html(
          (await readFile(new URL("./board/index.html", import.meta.url), "utf8"))
            .replaceAll("{{repo}}", config.repo)
            .replaceAll("{{base}}", config.base),
        ),
    }),

    registerApiRoute("/board/style.css", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) =>
        c.text(await readFile(new URL("./board/style.css", import.meta.url), "utf8"), 200, {
          "Content-Type": "text/css; charset=utf-8",
        }),
    }),

    registerApiRoute("/board/app.js", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) =>
        c.text(
          (await readFile(new URL("./board/app.js", import.meta.url), "utf8"))
            .replaceAll("{{repo}}", config.repo)
            .replaceAll("{{base}}", config.base),
          200,
          { "Content-Type": "application/javascript; charset=utf-8" },
        ),
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
        const boxes = await sandbox.list().catch(()=>null);

        for (const card of cards) if (card.lane?.workItem) {
          const item = card.lane.workItem;
          const offline = boxes?.find(s => s.name === `fx-uat-${item}`);
          card.sandbox = offline ? `${offline.status} (offline UAT)` : boxes?.find(s=>s.name === `fx-${item}`)?.status ?? (boxes ? 'missing' : 'unavailable');
        }

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
                status: "Accepted · ready to clean up",
              });

            if (state === "CLOSED")
              Object.assign(c, { status: "Rejected without merging" });
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
            column: "Items",
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
          repo: config.repo,
          base: config.base,
          columns: COLUMNS,
          cards: [...waiting, ...cards],
          allPaused,
          issuesError: issues.error,
        });
      },
    }),

    registerApiRoute('/board/github-pr/:issue', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const issue = itemId(c.req.param('issue'));
        const runId = runIdFor(issue);
        const [v, lane] = await Promise.all([view(factory(), runId), laneState(factory(), runId)]);
        const repo = githubRepo(githubRemote);
        const file = lane?.workItem && join(config.checkout, '.factory/delivered', `${lane.workItem}.md`);

        if (!repo || !file || v?.status !== 'success' || v.prUrl !== `file://${file}` || busy.has(runId))
          return c.json({ error: 'No finished local change to open on GitHub' }, 409);

        busy.add(runId);

        try {
          const url = await openLocalPr(repo, lane.base, lane.workItem, file);
          return c.json({ url });
        } catch (error) {
          return c.json({ error: (error as Error).message }, 500);
        } finally {
          busy.delete(runId);
        }
      },
    }),

    registerApiRoute("/board/diff/:issue", {
      method: "GET",
      requiresAuth: false,
      handler: async (c) => {
        const lane = await laneState(
          factory(),
          runIdFor(itemId(c.req.param("issue"))),
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
          runIdFor(itemId(c.req.param("issue"))),
        );

        const text = lane?.worktree
          ? await readFile(checksLog(lane.worktree), "utf8").catch(() =>
              // Runs from before the log moved into the worktree.
              readFile(
                `${stateRoot}/logs/${lane.workItem}.log`,
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

    registerApiRoute('/board/recreate/:issue', {
      method:'POST', requiresAuth:false,
      handler: async c => {
        const id = runIdFor(itemId(c.req.param('issue')));
        const {token} = await c.req.json<{token?:string}>();
        const [current,lane] = await Promise.all([card(factory(),id),laneState(factory(),id)]);

        if (!lane?.workItem || busy.has(id) || current?.waiting?.kind !== 'error' || !token || token !== current.token) return c.json({error:'No matching error wait'},409);

        busy.add(id);

        try {
          const wt = lane.worktree || `${config.worktrees}${lane.workItem}`;
          await sandbox.remove(lane.workItem,true);
          await sandbox.remove(lane.workItem);
          await prepareSandbox(lane.workItem,wt);
          return c.json({ok:true}); // Keep the human wait: Retry is a separate action.
        } catch(err) { return c.json({error:(err as Error).message},500); }
        finally { busy.delete(id); }
      },
    }),

    // Items are created through the tracker, so the board needs no GitHub form (or any other tracker's).
    registerApiRoute("/board/new", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const { title, body } = await c.req.json<{ title?: string; body?: string }>();

        if (!title?.trim() || !body?.trim()) return c.json({ error: "A title and a description are required" }, 400);

        try {
          const { id } = await tracker.create("task", { title: title.trim(), body: body.trim() });
          issues.at = 0; // show it without waiting for the next poll
          return c.json({ id });
        } catch (err) { return c.json({ error: (err as Error).message }, 500); }
      },
    }),

    registerApiRoute("/board/start/:issue", {
      method: "POST",
      requiresAuth: false,
      handler: async (c) => {
        const issue = itemId(c.req.param("issue"));
        const runId = runIdFor(issue);

        if (busy.has(runId) || (await view(factory(), runId)))
          return c.json({ error: `${issue} already has a run` }, 409);

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
        const issue = itemId(c.req.param("issue"));
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
          if (lane?.workItem) {
            const wt = lane.worktree || `${config.worktrees}${lane.workItem}`;

            if (await ownsWorktree(wt)) await removeTask(wt,lane.workItem,!!abandon);
            else if (lane.worktree) throw Error('Worktree predates sandbox ownership records; clean it up with its original factory');
          }

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
          const target = raw === "all" ? "all" : runIdFor(itemId(raw));
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
        const runId = runIdFor(itemId(c.req.param("issue")));

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
