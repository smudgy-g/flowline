// The lane as a Mastra workflow (fast, or standard with plan review and a wider code review):
//
//   intake → ┌ plan (human approves) → provision → ┌ implement → test → review → outcome (human approves) ┐ ┐ → draft PR
//            │                                     └──────────── until the outcome is approved ───────────┘ │
//            │                                       → prepare (commit, push) → UAT                         │
//            └──────────────────────────── until UAT passes (a client failure replans) ─────────────────────┘
//
// A step that needs a person or the driver suspends with a payload saying what it waits for (`kind`).
// A step that fails unexpectedly also suspends (kind 'error'), so a factory fix and `fx retry` continue the run.
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { config } from "./config.ts";
import {
  blockingFindings,
  breakdownPrompt,
  coderPrompt,
  findingsFormatPrompt,
  parsePlan,
  planPrompt,
  parseSteps,
  parseUnfinished,
  planSteps,
  describeFindings,
  describeUatFailure,
  draftPrBody,
  parseFindings,
  reviewPrompt,
  uatOutcome,
  workItemName,
  laneOf,
  parseProposedPrs,
  planReviewPrompt,
  splitIssue,
  tagged,
  CODE_REVIEWERS,
  MAX_PLAN_REVISIONS,
  PLAN_REVIEWERS,
  type Lane,
  type Finding,
  type Issue,
  type Plan,
  type UatReport,
} from "./rules.ts";

/** Every side effect the lane has. ops.ts is the real one; tests pass fakes. */
export type Ops = {
  /** Someone asked this run (or every run) to pause: it stops before its next step and waits until resumed. */
  paused(runId: string): Promise<boolean>;
  readIssue(number: number): Promise<Issue>;
  /** Labels the issue as this factory's; fails if another factory has claimed it. Safe to repeat. */
  claim(number: number): Promise<void>;
  branchExists(branch: string): Promise<boolean>;
  /**
   * Factory commit whose UAT inputs (specs, seeds, baseline) this work item is judged against: HEAD, or `at`
   * checked; with `after`, only a commit descending from it.
   */
  uatBaseline(at?: string, after?: string): Promise<string>;
  provision(branch: string, base: string): Promise<string>;
  checkWorktree(worktree: string): Promise<void>;
  runPi(
    worktree: string,
    role: "coder" | "review" | "planner",
    prompt: string,
  ): Promise<string>;
  /** Formats changed files and refuses migrations; returns the changed files. */
  inspect(worktree: string): Promise<{ files: string[]; sensitive: string[] }>;
  fingerprint(worktree: string): Promise<string>;
  runGates(
    worktree: string,
  ): Promise<{ ok: true } | { ok: false; gate: string; output: string }>;
  commitAndPush(worktree: string, message: string): Promise<string>;
  pushedHead(worktree: string): Promise<string>;
  runUat(
    branch: string,
    baseline: string,
  ): Promise<{ run: string; report: UatReport }>;
  openDraftPr(worktree: string, title: string, body: string): Promise<string>;
  commentOnIssue(number: number, text: string): Promise<void>;
  /** Fails unless every named skill loads in the worktree (a standard run checks its reviewers before it starts). */
  checkSkills(worktree: string, skills: string[]): Promise<void>;
  /** Creates a Factory task issue (label `factory`); returns its number. */
  createIssue(title: string, body: string): Promise<number>;
  /** A stack member split into more PRs: the stack inserts `parts` after it when it finishes. */
  recordSplit(base: string, member: number, parts: string[]): Promise<void>;
  /** Adds an entry to the work item's written history (in its worktree). */
  record(worktree: string, title: string, body?: string): Promise<void>;
};

export const MAX_BUILD_CYCLES = 6;
/** What a task builds on: the configured base, or a stack's branch. Checked, since it becomes a git argument. */
export const Base = z
  .string()
  .refine(
    (b) => b === config.base || /^stack\/[a-z0-9][a-z0-9-]*$/.test(b),
    `${config.base} or stack/<name>`,
  );

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  author: z.string(),
  comments: z.array(z.string()),
});
const PlanSchema = z.object({
  summary: z.string().min(1),
  tests: z.string().min(1),
});
const FindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string(),
  line: z.number(),
  description: z.string(),
});

export const LaneState = z.object({
  workItem: z.string(),
  base: z.string(),
  /** From the issue form: `standard` adds plan review and a wider code review. Older runs have none: fast. */
  lane: z.enum(["fast", "standard"]).optional(),
  /** After a split, the one part of the issue this run builds; the other parts are their own PRs. */
  scope: z.string().optional(),
  /** The other parts of a split, and the issues already created for them (a single issue only). */
  split: z
    .object({ parts: z.array(z.string()), created: z.array(z.number()) })
    .optional(),
  issue: IssueSchema.optional(),
  baseline: z.string(),
  worktree: z.string(),
  plan: PlanSchema.optional(),
  /** What the coder must address next: failed tests, blocking findings, a rejection or a UAT failure. */
  feedback: z.string(),
  /**
   * What the human decided after the plan was approved (send-back notes, retry notes). They override the plan, and
   * go to every later coder and reviewer, so a reviewer checking against the plan can't undo them.
   */
  decisions: z.array(z.string()).optional(),
  /** The coder's last reply: why it stopped, what it skipped. Shown on the card. */
  coderReply: z.string().optional(),
  /** The approved plan's steps, one coder call each: its own numbered ones, or the planner's split of it. */
  steps: z.array(z.string()).optional(),
  /** Steps already given to the coder, so a restart mid-round goes on from the next one. */
  stepsDone: z.number().optional(),
  /** Steps (1-based) the round's whole-plan call left unfinished and that still get their own call this round. */
  rerun: z.array(z.number()).optional(),
  cycles: z.number(),
  lowNotes: z.array(z.string()),
  testedDigest: z.string(),
  approvedDigest: z.string(),
  pushedSha: z.string(),
  uatRun: z.string(),
  uatReport: z.any().optional(),
  prUrl: z.string(),
});
export type LaneState = z.infer<typeof LaneState>;
export const initialState = (): LaneState => ({
  workItem: "",
  base: config.base,
  baseline: "",
  worktree: "",
  feedback: "",
  cycles: 0,
  lowNotes: [],
  testedDigest: "",
  approvedDigest: "",
  pushedSha: "",
  uatRun: "",
  prUrl: "",
});

/** What a person or the driver sends to a suspended step (`fx plan|approve|reject|findings|retry`). */
const Resume = z.object({
  retry: z.boolean().optional(),
  /** With retry: a note for the coder, kept as a decision. */
  note: z.string().optional(),
  /** With retry: test and review the change as it is, without a coder round (the code is right; something else was wrong). */
  proceed: z.boolean().optional(),
  /** With retry or an approval: judge UAT against this later factory commit (a fixed journey). Forward only. */
  baseline: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "a factory commit sha")
    .optional(),
  plan: PlanSchema.optional(),
  approve: z
    .boolean()
    .optional()
    .describe("Tick to approve the plan or outcome this step is waiting on"),
  reject: z.string().optional(),
  findings: z.array(FindingSchema).optional(),
  /** At plan approval: split the work into these PRs, in order; this run keeps the first. */
  split: z.array(z.string()).optional(),
});
export const Waiting = z
  .object({ kind: z.string(), message: z.string() })
  .catchall(z.unknown());
/** Inside one delivery attempt: is the build still good, and has the human approved its outcome? */
const Build = z.object({ ok: z.boolean(), approved: z.boolean() });
const Delivery = z.object({ uatPassed: z.boolean() });

/** What a paused run waits with. Resuming it runs the step as if fresh. */
export const PAUSED = {
  kind: "paused",
  message:
    "Paused. Resume when you're ready; after a sync it carries on with the new code.",
};

export type Ctx<I, S = LaneState, R = z.infer<typeof Resume>> = {
  /** A pause was asked for: a long step checks between its parts and returns suspend(PAUSED). */
  paused: () => Promise<boolean>;
  inputData: I;
  state: S;
  setState: (s: S) => Promise<void>;
  resumeData?: R;
  suspendData?: z.infer<typeof Waiting>;
  suspend: (payload: z.infer<typeof Waiting>) => Promise<any>;
};

/** A guarded step: unexpected errors suspend as kind 'error' instead of failing the run. The stack passes its own schemas. */
export function guardedStep<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  S extends z.ZodTypeAny = typeof LaneState,
  R extends z.ZodTypeAny = typeof Resume,
>(
  id: string,
  inputSchema: I,
  outputSchema: O,
  run: (ctx: Ctx<z.infer<I>, z.infer<S>, z.infer<R>>) => Promise<z.infer<O>>,
  schemas?: { state: S; resume: R },
  paused: (runId: string) => Promise<boolean> = async () => false,
) {
  return createStep({
    id,
    inputSchema,
    outputSchema,
    stateSchema: (schemas?.state ?? LaneState) as S,
    resumeSchema: (schemas?.resume ?? Resume) as R,
    suspendSchema: Waiting,
    execute: async (params: any) => {
      const isPaused = () => paused(params.runId);
      // A person's answer to a wait always goes through; a pause stops the run before the next step instead.
      if (!params.resumeData && (await isPaused()))
        return params.suspend(PAUSED);
      // Resumed from a pause, the step runs as if fresh: the pause was not a gate it asked for.
      const fromPause = params.suspendData?.kind === PAUSED.kind;
      const ctx = {
        ...params,
        paused: isPaused,
        resumeData: fromPause ? undefined : params.resumeData,
        // On `fx retry` the step starts over, so an error payload is not treated as an earlier gate.
        suspendData:
          fromPause || params.resumeData?.retry ? undefined : params.suspendData,
        setState: (s: z.infer<S>) => params.setState(s),
      };
      try {
        return await run(ctx);
      } catch (error) {
        return params.suspend({
          kind: "error",
          message: `${id} failed: ${(error as Error).message}. Fix the cause, then fx retry.`,
        });
      }
    },
  });
}

const planText = (plan: Plan) => `${plan.summary}\n\nTests:\n${plan.tests}`;

export type Reviews = {
  findings: Finding[];
  /** Reviewers whose reply had no parseable findings, even when asked again: recorded and skipped. */
  unparsed: string[];
  /** A proposed PR list (the first reviewer's that has one), or []. */
  proposed: string[];
};

/** One fresh read-only call per skill, in parallel; each finding tagged with its reviewer. */
export async function runReviewers(
  skills: string[],
  prompt: (skill: string) => string,
  call: (prompt: string) => Promise<string>,
): Promise<Reviews> {
  const results = await Promise.all(
    skills.map(async (skill) => {
      const reply = await call(prompt(skill));
      const findings =
        parseFindings(reply) ??
        parseFindings(await call(findingsFormatPrompt(reply)));
      return { skill, findings, proposed: parseProposedPrs(reply) };
    }),
  );
  return {
    findings: results.flatMap((r) =>
      r.findings ? tagged(r.skill, r.findings) : [],
    ),
    unparsed: results.filter((r) => !r.findings).map((r) => r.skill),
    proposed: results.map((r) => r.proposed).find((p) => p.length > 1) ?? [],
  };
}

export const describeReviews = (r: Reviews) =>
  [
    r.findings.length ? describeFindings(r.findings) : "No findings.",
    r.unparsed.length &&
      `No parseable findings from: ${r.unparsed.join(", ")} (skipped).`,
    r.proposed.length &&
      `Proposed PRs:\n${r.proposed.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

const Input = z.object({
  issue: z.number().int().positive(),
  base: Base.default(config.base),
});

export function createFastLane(ops: Ops) {
  const laneStep: typeof guardedStep = (id, i, o, run, schemas) =>
    guardedStep(id, i, o, run, schemas, ops.paused);

  /** Judges UAT against a later factory commit (a fixed journey) from now on; forward only. */
  async function moveBaseline(state: LaneState, at: string) {
    const baseline = await ops.uatBaseline(at, state.baseline);
    await ops.record(
      state.worktree,
      "You moved the UAT inputs forward",
      `${state.baseline} → ${baseline}`,
    );
    return { ...state, baseline };
  }

  const intake = laneStep(
    "intake",
    Input,
    Delivery,
    async ({ inputData, state, setState }) => {
      const issue = await ops.readIssue(inputData.issue);
      await ops.claim(issue.number);
      const workItem = workItemName(issue);
      if (await ops.branchExists(workItem))
        throw new Error(
          `Branch ${workItem} already exists; another run or a person owns it`,
        );
      await setState({
        ...state,
        issue,
        workItem,
        lane: laneOf(issue.body),
        base: inputData.base,
        baseline: await ops.uatBaseline(),
      });
      return { uatPassed: false };
    },
  );

  const plan = laneStep(
    "plan",
    Delivery,
    Build,
    async ({ state, setState, resumeData, suspendData, suspend }) => {
      if (resumeData?.approve && suspendData?.kind === "plan-approval") {
        if (resumeData.baseline)
          state = await moveBaseline(state, resumeData.baseline);
        await ops.record(
          state.worktree,
          state.plan
            ? "You approved a revised plan"
            : `You approved the plan for #${state.issue!.number}: ${state.issue!.title}`,
          planText(suspendData.plan as Plan),
        );

        await setState({
          ...state,
          plan: suspendData.plan as Plan,
          steps: undefined,
          stepsDone: 0,
        });
        return { ok: true, approved: false };
      }
      if (resumeData?.plan) {
        return suspend({
          kind: "plan-approval",
          message: "Human: read the plan, then approve (or reject with why).",
          plan: resumeData.plan,
        });
      }
      if (resumeData?.reject) {
        await ops.record(
          state.worktree,
          "You sent the plan back",
          resumeData.reject,
        );
      }

      // A split: this run keeps the first part and the plan is redrafted for it alone. The other parts become
      // sub-issues when a stack member finishes (stack.ts), or new issues now.
      const parts = (resumeData?.split ?? []).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1 && suspendData?.kind === "plan-approval") {
        state = {
          ...state,
          scope: parts[0],
          split: { parts: parts.slice(1), created: [] },
        };
        await setState(state);
        if (state.base !== config.base)
          await ops.recordSplit(state.base, state.issue!.number, parts.slice(1));
        await ops.record(
          state.worktree,
          `You split this into ${parts.length} PRs`,
          parts.map((p, i) => `${i + 1}. ${p}`).join("\n"),
        );
      }
      // Restart-safe: issues for the other parts are created one at a time and saved, so none is made twice.
      if (state.base === config.base && state.split) {
        const { parts: rest, created } = state.split;
        for (const part of rest.slice(created.length)) {
          const { title, body } = splitIssue(
            state.issue!,
            part,
            state.lane ?? "fast",
          );
          created.push(await ops.createIssue(title, body));
          state = { ...state, split: { parts: rest, created: [...created] } };
          await setState(state);
          if (created.length === rest.length)
            await ops.commentOnIssue(
              state.issue!.number,
              `Split into ${rest.length + 1} PRs. This one: ${state.scope}. The rest: ${created.map((n) => `#${n}`).join(", ")}.`,
            );
        }
      }

      // The planner drafts (or revises) the plan; the human approves it. A rejection, a UAT failure and earlier
      // decisions are what it revises against. state.feedback stays for the coder.
      const why = [
        resumeData?.reject && `Plan sent back: ${resumeData.reject}`,
        state.feedback,
        ...(state.decisions ?? []),
      ]
        .filter(Boolean)
        .join("\n");
      const previous =
        suspendData?.kind === "plan-approval"
          ? (suspendData.plan as Plan)
          : state.plan;
      let drafted = parsePlan(
        await ops.runPi(
          state.worktree,
          "planner",
          planPrompt(
            state.issue!,
            why || previous ? { draft: previous, notes: why } : undefined,
            state.scope,
          ),
        ),
      );

      if (!drafted)
        // The planner gave nothing usable: the human or the driver writes it, as before.
        return suspend({
          kind: "plan",
          message: `The planner gave no usable plan. Write it here, or ask the driver.${why ? `\n${why}` : ""}`,
          issue: state.issue,
        });

      await ops.record(
        state.worktree,
        "The planner drafted a plan",
        [
          planText(drafted.plan),
          drafted.questions.length &&
            `Open questions:\n${drafted.questions.map((q) => `- ${q}`).join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );

      // Standard: reviewers check every draft; what they find goes back to the planner up to MAX_PLAN_REVISIONS
      // times, then the plan waits for you with whatever is still open. A PR split is only ever proposed.
      // ponytail: a restart mid-review starts the drafting and review over; save each round if restarts get common.
      let reviews: Reviews | undefined;
      if (state.lane === "standard") {
        for (let revision = 0; ; revision++) {
          const current = drafted;
          reviews = await runReviewers(
            PLAN_REVIEWERS,
            (skill) =>
              planReviewPrompt(
                state.issue!,
                current.plan,
                current.questions,
                skill,
                state.scope,
              ),
            (prompt) => ops.runPi(state.worktree, "review", prompt),
          );
          const open = reviews.findings.filter((f) => f.severity !== "low");
          await ops.record(
            state.worktree,
            `Plan review${revision ? ` of revision ${revision}` : ""}: ${open.length ? `${open.length} to address` : "nothing to address"}`,
            describeReviews(reviews),
          );
          if (!open.length || revision >= MAX_PLAN_REVISIONS) break;
          const revised = parsePlan(
            await ops.runPi(
              state.worktree,
              "planner",
              planPrompt(
                state.issue!,
                { draft: current.plan, notes: why, findings: describeFindings(open) },
                state.scope,
              ),
            ),
          );
          if (!revised) break;
          drafted = revised;
          await ops.record(
            state.worktree,
            `The planner revised the plan (revision ${revision + 1})`,
            [
              planText(revised.plan),
              revised.questions.length &&
                `Open questions:\n${revised.questions.map((q) => `- ${q}`).join("\n")}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
        }
      }

      return suspend({
        kind: "plan-approval",
        message:
          "Human: read the plan, then approve (or send it back with what to change).",
        plan: drafted.plan,
        questions: drafted.questions,
        ...(reviews && {
          findings: reviews.findings,
          proposedPrs: reviews.proposed,
          unreviewed: reviews.unparsed,
        }),
        ...(state.scope && { scope: state.scope }),
      });
    },
  );

  // Before the plan: the planner reads the code in the worktree.
  const provision = laneStep(
    "provision",
    Delivery,
    Delivery,
    async ({ inputData, state, setState }) => {
      if (state.worktree) {
        await ops.checkWorktree(state.worktree);
      } else {
        const worktree = await ops.provision(state.workItem, state.base);
        await setState({ ...state, worktree });
        if (state.lane === "standard")
          await ops.checkSkills(worktree, [
            ...new Set([...PLAN_REVIEWERS, ...CODE_REVIEWERS]),
          ]);
      }

      return inputData;
    },
  );

  const implement = laneStep(
    "implement",
    Build,
    Build,
    async ({ state, setState, resumeData, suspend, paused }) => {
      if (state.cycles >= MAX_BUILD_CYCLES && !resumeData?.retry) {
        await ops.record(
          state.worktree,
          `Stopped after ${MAX_BUILD_CYCLES} rounds`,
          "Waiting for Retry or Abandon.",
        );

        return suspend({
          kind: "cycle-limit",
          message: `${MAX_BUILD_CYCLES} build cycles without an approved outcome. fx retry allows ${MAX_BUILD_CYCLES} more; or abort.`,
          feedback: state.feedback,
        });
      }

      const cycles =
        resumeData?.retry && state.cycles >= MAX_BUILD_CYCLES
          ? 0
          : state.cycles;

      const note = resumeData?.retry ? resumeData.note?.trim() : undefined;

      if (note) {
        await ops.record(state.worktree, "You retried with a decision", note);

        state = {
          ...state,
          decisions: [...(state.decisions ?? []), note],
          feedback: [note, state.feedback].filter(Boolean).join("\n\n"),
        };
      }

      if (resumeData?.retry && resumeData.baseline)
        state = await moveBaseline(state, resumeData.baseline);

      if (resumeData?.retry && resumeData.proceed) {
        await ops.record(
          state.worktree,
          `Round ${cycles} · you sent the change to the checks as it is`,
        );
        await setState({ ...state, cycles, feedback: "" });
        return { ok: true, approved: false };
      }

      // An approved plan's steps go to the coder one call each (saved as they go), then one whole-plan call with any
      // feedback. Once given, later rounds are just that last call.
      // A plan without numbered steps (a spec pasted as is) is split by a read-only planner that reads the code, as
      // Swamp's controller did by hand. An unusable split leaves it one step, as before.
      let steps = state.steps;
      if (!steps) {
        steps = planSteps(state.plan!.summary);
        if (!steps.length)
          steps =
            parseSteps(
              await ops.runPi(
                state.worktree,
                "planner",
                breakdownPrompt(state.plan!),
              ),
            ) ?? [];
        state = { ...state, steps };
        await setState(state);
      }
      const replies: string[] = [];
      const round = cycles + 1;
      // Restarted while the whole-plan call's unfinished steps were being given out: that call is done.
      const resuming = !!state.rerun?.length;
      // Restarted mid-round, the steps already given are in the worktree, so there is nothing to compare against.
      const midRound =
        resuming ||
        ((state.stepsDone ?? 0) > 0 && state.stepsDone! < steps.length);
      const before = midRound ? null : await ops.fingerprint(state.worktree);

      const giveStep = async (index: number, again: boolean) => {
        const stepReply = await ops.runPi(
          state.worktree,
          "coder",
          coderPrompt(state.issue!, state.plan!, "", state.decisions, {
            index,
            total: steps.length,
            text: steps[index],
          }),
        );
        replies.push(`Step ${index + 1}${again ? " again" : ""}: ${stepReply}`);
        await ops.record(
          state.worktree,
          `Round ${round} · coder, step ${index + 1} of ${steps.length}${again ? " again" : ""}`,
          `${steps[index]}\n\nThe coder said:\n${stepReply}`,
        );
      };

      // Pauses between coder calls only where a restart picks up exactly there (mid-round, or mid re-run).
      for (let index = state.stepsDone ?? 0; index < steps.length; index++) {
        if (index > (state.stepsDone ?? 0) && (await paused()))
          return suspend(PAUSED);
        await giveStep(index, false);
        await setState({
          ...state,
          stepsDone: index + 1,
          coderReply: replies.join("\n\n").slice(-6000),
        });
      }

      if (!resuming) {
        const reply = await ops.runPi(
          state.worktree,
          "coder",
          coderPrompt(state.issue!, state.plan!, state.feedback, state.decisions),
        );
        replies.push(reply);
        const { files } = await ops.inspect(state.worktree);
        const rerun = parseUnfinished(reply, steps.length);

        await ops.record(
          state.worktree,
          `Round ${round} · coder`,
          [
            state.feedback && `Asked to fix:\n${state.feedback.slice(-2000)}`,
            `The coder said:\n${reply}`,
            `Files in the change now: ${files.length ? files.join(", ") : "none"}`,
            rerun.length && `Steps ${rerun.join(", ")} each get their own call now.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        state = {
          ...state,
          stepsDone: steps.length,
          rerun,
          coderReply: replies.join("\n\n").slice(-6000),
        };
        await setState(state);
      }

      // A whole-plan call faced with big unfinished steps gives up on them; one call per step gets them done.
      while (state.rerun?.length) {
        if (await paused()) return suspend(PAUSED);
        const [step, ...rest] = state.rerun;
        await giveStep(step - 1, true);
        state = {
          ...state,
          rerun: rest,
          coderReply: replies.join("\n\n").slice(-6000),
        };
        await setState(state);
      }

      const { files } = await ops.inspect(state.worktree);
      const reply = replies.at(-1) ?? state.coderReply ?? "";
      await setState({
        ...state,
        cycles: cycles + 1,
        feedback: "",
        stepsDone: steps.length,
        rerun: [],
        coderReply: replies.join("\n\n").slice(-6000) || state.coderReply,
      });
      // Nothing new to test: the coder stopped (blocked, or it thinks it's done). Its reply says why; testing would only
      // send it the same failure again. A changed plan or a fix outside the worktree comes first. Earlier rounds'
      // files don't count, so this compares with the round's start, not with the base.
      if (
        !files.length ||
        (before !== null && (await ops.fingerprint(state.worktree)) === before)
      )
        return suspend({
          kind: "no-change",
          message: `The coder changed nothing this round. It said:\n${reply.slice(-3000)}\n\nRetry with a note, or Proceed to test the change as it is.`,
          reply,
        });
      return { ok: true, approved: false };
    },
  );

  const test = laneStep(
    "test",
    Build,
    Build,
    async ({ inputData, state, setState }) => {
      if (!inputData.ok) return inputData;
      const result = await ops.runGates(state.worktree);

      await ops.record(
        state.worktree,
        `Round ${state.cycles} · checks ${result.ok ? "passed" : `failed at "${result.gate}"`}`,
        result.ok ? "" : `\`\`\`\n${result.output.trim()}\n\`\`\``,
      );

      if (!result.ok) {
        await setState({
          ...state,
          feedback: `Test gate "${result.gate}" failed:\n${result.output}`,
        });
        return { ok: false, approved: false };
      }
      await setState({
        ...state,
        testedDigest: await ops.fingerprint(state.worktree),
      });
      return inputData;
    },
  );

  const review = laneStep(
    "review",
    Build,
    Build,
    async ({ inputData, state, setState, resumeData, suspendData, suspend }) => {
      if (!inputData.ok) return inputData;
      const call = (prompt: string) =>
        ops.runPi(state.worktree, "review", prompt);
      // Standard: four more reviewers alongside the main one. Their findings are kept while the main one's wait for
      // `fx findings`, so answering that doesn't run them again.
      const extras: Promise<Reviews> =
        state.lane !== "standard"
          ? Promise.resolve({ findings: [], unparsed: [], proposed: [] })
          : suspendData?.kind === "findings" && suspendData.extra
            ? Promise.resolve(suspendData.extra as Reviews)
            : runReviewers(
                CODE_REVIEWERS,
                (skill) =>
                  reviewPrompt(
                    `origin/${state.base}`,
                    state.plan!,
                    state.decisions,
                    skill,
                  ),
                call,
              );
      extras.catch(() => {}); // awaited below; a failure while the main review runs must not go unhandled
      let findings: Finding[] | null = resumeData?.findings ?? null;
      let reply = "";
      if (!findings) {
        reply = await call(
          reviewPrompt(`origin/${state.base}`, state.plan!, state.decisions),
        );
        findings =
          parseFindings(reply) ??
          parseFindings(await call(findingsFormatPrompt(reply)));
      }
      const extra = await extras;
      if (!findings)
        return suspend({
          kind: "findings",
          message:
            "The reviewer gave no parseable findings, even when asked again. Retry runs the review again.",
          reply,
          extra,
        });
      if (extra.unparsed.length)
        await ops.record(
          state.worktree,
          `Round ${state.cycles} · skipped reviewers`,
          `No parseable findings from: ${extra.unparsed.join(", ")}.`,
        );
      findings = [...findings, ...extra.findings];
      const blocking = blockingFindings(findings);
      const lowNotes = findings
        .filter((f) => !blocking.includes(f))
        .map((f) => `${f.severity} ${f.file}:${f.line} ${f.description}`);

      await ops.record(
        state.worktree,
        `Round ${state.cycles} · review: ${blocking.length ? `${blocking.length} blocking` : "nothing blocking"}`,
        [
          blocking.length && describeFindings(blocking),
          lowNotes.length && `Notes:\n${lowNotes.join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      await setState({
        ...state,
        lowNotes,
        feedback: blocking.length
          ? `Code review findings:\n${describeFindings(blocking)}`
          : "",
      });
      return { ok: blocking.length === 0, approved: false };
    },
  );

  const outcome = laneStep(
    "outcome",
    Build,
    Build,
    async ({
      inputData,
      state,
      setState,
      resumeData,
      suspendData,
      suspend,
    }) => {
      if (!inputData.ok) return inputData;
      if (resumeData?.reject) {
        await ops.record(
          state.worktree,
          `Round ${state.cycles} · you sent the change back`,
          resumeData.reject,
        );

        await setState({
          ...state,
          decisions: [...(state.decisions ?? []), resumeData.reject],
          cycles: 0,
          feedback: `Outcome rejected by the human: ${resumeData.reject}`,
        });
        return { ok: false, approved: false };
      }
      const { files, sensitive } = await ops.inspect(state.worktree);
      const digest = await ops.fingerprint(state.worktree);
      if (digest !== state.testedDigest)
        return suspend({
          kind: "changed",
          message:
            'Files changed after testing. Revert those edits and fx retry, or fx reject "<why>" to send it back to implement.',
          files,
        });
      if (resumeData?.approve) {
        // Approval is for what was shown: the digest the gate suspended with.
        if (suspendData?.digest === digest) {
          if (resumeData.baseline)
            state = await moveBaseline(state, resumeData.baseline);
          await ops.record(
            state.worktree,
            `Round ${state.cycles} · you approved the change`,
            `Files: ${files.join(", ")}`,
          );

          await setState({ ...state, approvedDigest: digest });
          return { ok: true, approved: true };
        }
        // Someone edited the worktree while the gate waited: ask again.
      }
      return suspend({
        kind: "outcome-approval",
        message:
          "Human: review the diff (wx open <work item>), then approve (or reject with why).",
        digest,
        files,
        sensitive,
        lowNotes: state.lowNotes,
      });
    },
  );

  const build = createWorkflow({
    id: "build",
    inputSchema: Build,
    outputSchema: Build,
    stateSchema: LaneState,
  })
    .then(implement)
    .then(test)
    .then(review)
    .then(outcome)
    .commit();

  const prepare = laneStep(
    "prepare",
    Build,
    Build,
    async ({ inputData, state, setState }) => {
      const digest = await ops.fingerprint(state.worktree);
      if (digest !== state.approvedDigest || digest !== state.testedDigest)
        throw new Error("Worktree differs from the approved, tested change");
      // The title only: GitHub appends "(#PR)" on squash, and the PR body already links the issue.
      const sha = await ops.commitAndPush(state.worktree, state.issue!.title);
      await setState({ ...state, pushedSha: sha });
      return inputData;
    },
  );

  const uat = laneStep("uat", Build, Delivery, async ({ state, setState }) => {
    if ((await ops.pushedHead(state.worktree)) !== state.pushedSha)
      throw new Error("Task branch moved since it was pushed");
    const { run, report } = await ops.runUat(state.workItem, state.baseline);
    const verdict = uatOutcome(report);
    if (verdict === "infrastructure")
      throw new Error(
        `UAT never reached a verdict (${report.error ?? "no journey ran, or Lighthouse gave no score"}); run ${run}`,
      );
    if (report.commit !== state.pushedSha)
      throw new Error(
        `UAT tested ${report.commit}, expected ${state.pushedSha}`,
      );
    await ops.record(
      state.worktree,
      `UAT ${verdict === "passed" ? "passed" : "failed"} (run ${run})`,
      verdict === "client" ? describeUatFailure(report) : "",
    );

    await setState({
      ...state,
      uatRun: run,
      uatReport: report,
      feedback: verdict === "client" ? describeUatFailure(report) : "",
    });
    return { uatPassed: verdict === "passed" };
  });

  const delivery = createWorkflow({
    id: "delivery",
    inputSchema: Delivery,
    outputSchema: Delivery,
    stateSchema: LaneState,
  })
    .then(provision)
    .then(plan)
    .dountil(build, async ({ inputData }) => inputData.approved)
    .then(prepare)
    .then(uat)
    .commit();

  const draftPr = laneStep(
    "draft-pr",
    Delivery,
    z.object({ prUrl: z.string() }),
    async ({ state, setState }) => {
      if ((await ops.pushedHead(state.worktree)) !== state.pushedSha)
        throw new Error("Task branch moved since UAT");
      const body = draftPrBody({
        issue: state.issue!,
        plan: state.plan!,
        report: state.uatReport,
        uatRun: state.uatRun,
        lowNotes: state.lowNotes,
      });
      const prUrl =
        state.prUrl ||
        (await ops.openDraftPr(state.worktree, state.issue!.title, body));
      await setState({ ...state, prUrl });

      await ops.record(state.worktree, "Draft PR opened", prUrl);

      await ops.commentOnIssue(state.issue!.number, `Draft PR: ${prUrl}`);
      return { prUrl };
    },
  );

  return createWorkflow({
    id: "fast-lane",
    description:
      "Fast lane: GitHub issue → approved plan → tested, reviewed, approved change → UAT → draft PR",
    inputSchema: Input,
    outputSchema: z.object({ prUrl: z.string() }),
    stateSchema: LaneState,
  })
    .then(intake)
    .dountil(delivery, async ({ inputData }) => inputData.uatPassed)
    .then(draftPr)
    .commit();
}
