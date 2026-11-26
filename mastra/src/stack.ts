// A stack: a bigger feature built as several PRs on one branch, shipped to staging as one.
//
//   intake → design (driver writes, human approves) → setup (stack branch, sub-issues) → members → draft PR to staging
//
// Each member is a normal fast-lane run whose base is the stack branch. A "(by hand)" member waits for the human's
// "done". The members step waits while a member runs; cleaning up the member's merged card continues it (board.ts).
// Every step is idempotent, so a retry or a resume re-runs it from the saved state.
//
// ponytail: staging is not merged into the stack branch between members (Swamp's sync_stack), and there is no UAT
// of the whole stack before its PR; each member is UAT'd on its own branch. Conflicts with staging show on the
// stack PR. Add a sync step before each member if staging moves under long stacks.
import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  describeReviews,
  guardedStep,
  runReviewers,
  type Reviews,
} from "./fast-lane.ts";
import {
  designReviewPrompt,
  memberIssue,
  memberOf,
  membersText,
  parseStack,
  workItemName,
  DESIGN_REVIEWERS,
  type Issue,
  type StackMember,
} from "./rules.ts";

/** The stack's side effects. ops.ts has the real ones; `members` starts and finds fast-lane runs (runs.ts). */
export type StackOps = {
  /** As the fast lane's: a pause stops the stack before its next step. */
  paused(runId: string): Promise<boolean>;
  readIssue(number: number): Promise<Issue>;
  /** As the fast lane's: the stack issue is this factory's. */
  claim(number: number): Promise<void>;
  /** Creates `branch` on GitHub from origin/staging, unless it exists. */
  createStackBranch(branch: string): Promise<void>;
  /**
   * Creates an issue and links it as the parent's sub-issue: the last one, or right after the sub-issue `after`.
   * Returns its number.
   */
  createSubIssue(
    parent: number,
    title: string,
    body: string,
    after?: number,
  ): Promise<number>;
  retitleIssue(number: number, title: string): Promise<void>;
  /** Replaces one form section (`### <name>`) of an issue's body. */
  updateIssueSection(number: number, name: string, text: string): Promise<void>;
  /** Runs read-only reviews in a fresh checkout of origin/staging, removed afterwards. */
  withReviewCheckout<T>(
    work: (call: (prompt: string) => Promise<string>) => Promise<T>,
  ): Promise<T>;
  /** The PRs a member was split into at its plan approval (fast-lane `recordSplit`), beyond its own; [] if none. */
  splitOf(branch: string, member: number): Promise<string[]>;
  issueOpen(number: number): Promise<boolean>;
  closeIssue(number: number, comment: string): Promise<void>;
  openStackPr(branch: string, title: string, body: string): Promise<string>;
  /** Adds an entry to the stack's written history (members read it). */
  record(branch: string, title: string, body?: string): Promise<void>;
  /** Saves the approved design beside the stack's history. */
  saveDesign(branch: string, design: string): Promise<void>;
};
export type Members = {
  start(issue: number, base: string): Promise<unknown>;
  has(issue: number): Promise<boolean>;
};

export const StackState = z.object({
  issue: z.any().optional(),
  branch: z.string(),
  members: z.array(
    z.object({
      title: z.string(),
      byHand: z.boolean(),
      number: z.number().optional(),
    }),
  ),
  design: z.string(),
  current: z.number(),
  prUrl: z.string(),
  /** From the stack form; every member runs in it. Older stacks have none: fast. */
  lane: z.enum(["fast", "standard"]).optional(),
  /** Members whose split has been put into `members`, so a restart never inserts it twice. */
  splitDone: z.array(z.number()).optional(),
});
export type StackState = z.infer<typeof StackState>;
export const initialStackState = (): StackState => ({
  branch: "",
  members: [],
  design: "",
  current: 0,
  prUrl: "",
});

const StackResume = z.object({
  retry: z.boolean().optional(),
  design: z.string().optional(),
  approve: z.boolean().optional(),
  reject: z.string().optional(),
  /** With approve: take the design reviewers' proposed PR list instead of the current one. */
  useProposed: z.boolean().optional(),
});
const schemas = { state: StackState, resume: StackResume };
const Step = z.object({});

export function createStack(ops: StackOps, members: Members) {
  const laneStep: typeof guardedStep = (id, i, o, run, schemas) =>
    guardedStep(id, i, o, run, schemas, ops.paused);
  const intake = laneStep(
    "stack-intake",
    z.object({ issue: z.number().int().positive() }),
    Step,
    async ({ inputData, state, setState }) => {
      const issue = await ops.readIssue(inputData.issue);
      await ops.claim(issue.number);
      const { members: list, lane } = parseStack(issue.body);
      if (!list.length)
        throw new Error(
          'The issue has no "PRs in order" list; use the Factory stack form',
        );
      if (lane && lane !== "fast lane" && lane !== "standard")
        throw new Error(`Lane "${lane}": use fast lane or standard`);
      await setState({
        ...state,
        issue,
        lane: lane === "standard" ? "standard" : "fast",
        branch: `stack/${workItemName(issue)}`,
        members: state.members.length ? state.members : list,
      });
      return {};
    },
    schemas,
  );

  const design = laneStep(
    "design",
    Step,
    Step,
    async ({ state, setState, resumeData, suspendData, suspend }) => {
      if (state.design) return {};
      if (resumeData?.approve && suspendData?.kind === "design-approval") {
        const approved = suspendData.design as string;
        const proposed = (suspendData.proposed ?? []) as StackMember[];
        const members =
          resumeData.useProposed && proposed.length ? proposed : state.members;

        if (members !== state.members) {
          await ops.updateIssueSection(
            (state.issue as Issue).number,
            "PRs in order",
            membersText(members),
          );
          await ops.record(
            state.branch,
            "You approved the proposed PR list",
            membersText(members),
          );
        }
        await ops.saveDesign(state.branch, approved);
        await ops.record(state.branch, "You approved the design", approved);
        await setState({ ...state, design: approved, members });

        return {};
      }

      if (resumeData?.reject) {
        await ops.record(
          state.branch,
          "You sent the design back",
          resumeData.reject,
        );
      }

      const issue = state.issue as Issue;
      const submitted = resumeData?.design?.trim();
      if (submitted) {
        // Standard: the design and PR list are reviewed before you approve; a changed list is only proposed.
        let reviews: Reviews | undefined;
        if (state.lane === "standard") {
          reviews = await ops.withReviewCheckout((call) =>
            runReviewers(
              DESIGN_REVIEWERS,
              (skill) =>
                designReviewPrompt(issue, submitted, state.members, skill),
              call,
            ),
          );
          await ops.record(
            state.branch,
            `Design review: ${reviews.findings.length} finding${reviews.findings.length === 1 ? "" : "s"}`,
            describeReviews(reviews),
          );
        }
        return suspend({
          kind: "design-approval",
          message:
            "Human: read the design, then approve (or send it back with why).",
          design: submitted,
          ...(reviews && {
            findings: reviews.findings,
            proposed: reviews.proposed.map(memberOf),
            unreviewed: reviews.unparsed,
          }),
        });
      }
      return suspend({
        kind: "design",
        draft: issue.comments.join("\n\n---\n\n"),
        message: `Driver: write one technical design for the whole stack: the data model, shared shapes, and what each PR reuses.${resumeData?.reject ? `\nSent back: ${resumeData.reject}` : ""}`,
      });
    },
    schemas,
  );

  /**
   * Creates the sub-issue of every member that has none yet, saved one by one so a retry never creates one twice.
   * `place`: put each right after the member before it (an inserted split), instead of last.
   */
  const createMissing = async (
    state: StackState,
    setState: (s: StackState) => Promise<void>,
    place: boolean,
  ): Promise<StackState> => {
    const list: StackMember[] = [...state.members];
    for (const [index, member] of list.entries()) {
      if (member.number) continue;
      const { title, body } = memberIssue({
        parent: state.issue as Issue,
        branch: state.branch,
        design: state.design,
        index,
        total: list.length,
        member,
        lane: state.lane,
      });
      const number = await ops.createSubIssue(
        (state.issue as Issue).number,
        title,
        body,
        place && index > 0 ? list[index - 1].number : undefined,
      );

      list[index] = { ...member, number };

      await ops.record(state.branch, `Sub-issue #${number} created`, title);

      state = { ...state, members: list };
      await setState(state);
    }
    return state;
  };

  /**
   * A finished member that was split at its plan approval: its other parts go in right after it, as sub-issues in
   * that place, and the parent's PR list and the later sub-issues' "n/total" titles follow.
   */
  const insertSplit = async (
    state: StackState,
    setState: (s: StackState) => Promise<void>,
    index: number,
  ): Promise<StackState> => {
    const member = state.members[index];
    const done = state.splitDone ?? [];
    if (member.byHand || done.includes(member.number!)) return state;
    const parts = await ops.splitOf(state.branch, member.number!);
    if (!parts.length) return state;
    const inserted = parts.map(memberOf);
    state = {
      ...state,
      members: [
        ...state.members.slice(0, index + 1),
        ...inserted,
        ...state.members.slice(index + 1),
      ],
      splitDone: [...done, member.number!],
    };
    await setState(state);
    await ops.record(
      state.branch,
      `PR ${index + 1} was split: ${inserted.length} more PR${inserted.length > 1 ? "s" : ""} after it`,
      parts.map((p) => `- ${p}`).join("\n"),
    );
    state = await createMissing(state, setState, true);
    const total = state.members.length;
    await ops.updateIssueSection(
      (state.issue as Issue).number,
      "PRs in order",
      membersText(state.members),
    );
    // ponytail: only titles follow; a later sub-issue's body still says its old "PR n of total".
    for (let i = index + inserted.length + 1; i < total; i++)
      await ops.retitleIssue(
        state.members[i].number!,
        `${i + 1}/${total} ${state.members[i].title}`.slice(0, 250),
      );
    return state;
  };

  const setup = laneStep(
    "setup",
    Step,
    Step,
    async ({ state, setState }) => {
      await ops.createStackBranch(state.branch);
      await createMissing(state, setState, false);
      return {};
    },
    schemas,
  );

  const run = laneStep(
    "members",
    Step,
    Step,
    async ({ state, setState, resumeData, suspendData, suspend }) => {
      // Moving past a member means it is finished: merged, closed, or done by hand.
      const finished = async (index: number) => {
        const member = state.members[index];

        await ops.record(
          state.branch,
          `PR ${index + 1} of ${state.members.length} finished`,
          `#${member.number} ${member.title}`,
        );
      };

      let current = state.current;

      // The list can grow as it goes: a finished member's split is inserted right after it.
      for (let index = current; index < state.members.length; index++) {
        const member = state.members[index];
        const number = member.number!;

        if (index !== current) {
          await finished(current);
          current = index;
          state = { ...state, current };
          await setState(state);
        }

        if (!(await ops.issueOpen(number))) {
          state = await insertSplit(state, setState, index);
          continue;
        }
        if (member.byHand) {
          if (
            resumeData?.approve &&
            suspendData?.kind === "by-hand" &&
            suspendData.number === number
          ) {
            await ops.closeIssue(number, "Done by hand.");
            continue;
          }
          return suspend({
            kind: "by-hand",
            number,
            index,
            message: `PR ${index + 1} of ${state.members.length} is done by hand: ${member.title} (#${number}). Click Done when it is.`,
          });
        }
        if (!(await members.has(number))) {
          await members.start(number, state.branch);
          await ops.record(
            state.branch,
            `PR ${index + 1} of ${state.members.length} started`,
            `#${number} ${member.title}`,
          );
        }

        return suspend({
          kind: "member-running",
          number,
          index,
          message: `PR ${index + 1} of ${state.members.length} runs as its own card (#${number}). When its PR is merged into ${state.branch}, clean that card up and the next one starts.`,
        });
      }
      const total = state.members.length;
      if (current < total) await finished(current);

      await setState({ ...state, current: total });

      return {};
    },
    schemas,
  );

  const finish = laneStep(
    "stack-pr",
    Step,
    z.object({ prUrl: z.string() }),
    async ({ state, setState }) => {
      const issue = state.issue as Issue;
      const list = state.members
        .map(
          (m, i) =>
            `${i + 1}. #${m.number} ${m.title}${m.byHand ? " (by hand)" : ""}`,
        )
        .join("\n");
      const opened = !state.prUrl;
      const prUrl =
        state.prUrl ||
        (await ops.openStackPr(
          state.branch,
          issue.title,
          `## Summary\nThe stack for #${issue.number}: ${issue.title}\n\n## PRs\n${list}\n\nCloses #${issue.number}\n\nHuman review required; no auto-merge.`,
        ));
      if (opened) await ops.record(state.branch, "Stack PR opened", prUrl);

      await setState({ ...state, prUrl });

      return { prUrl };
    },
    schemas,
  );

  return createWorkflow({
    id: "stack",
    description:
      "Colonia stack: Factory stack issue → approved design → sub-issues → fast-lane members on one branch → draft PR to staging",
    inputSchema: z.object({ issue: z.number().int().positive() }),
    outputSchema: z.object({ prUrl: z.string() }),
    stateSchema: StackState,
  })
    .then(intake)
    .then(design)
    .then(setup)
    .then(run)
    .then(finish)
    .commit();
}
