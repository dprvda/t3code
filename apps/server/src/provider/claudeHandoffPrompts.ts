/**
 * Handoff and continuation prompts for automatic context recycling.
 *
 * Ported from ADE `src/renderer/src/lib/handoff-prompts.ts` and
 * `src/shared/session-goal.ts` (2026-08-21). The wording is deliberate and
 * battle-tested: the completion marker must be the exact first words of the
 * final response so the reactor can detect it, and the successor prompt
 * carries the standing continue-across-sessions authority so a recycled
 * session never treats the handoff's first actions as the whole plan.
 *
 * @module claudeHandoffPrompts
 */

/** Exact first words the handoff turn must produce when it is done. */
export const HANDOFF_DONE_MARKER = "handoff procedure finished";

/** Proactive recycle: the agent still has headroom to wrap up properly. */
export const STANDARD_HANDOFF_PROMPT =
  "write a compressed handoff for your successor session into the repo's .claude/handoffs " +
  "directory (create it if missing) as a new timestamped markdown file. include: project state, " +
  "next actions, blockers, exact source paths, running or background work, git branch and " +
  "status, tests run or not run, and anything the next session must not redo. wait for working " +
  "agents to finish, write the handoff, then stop with no new work. after the handoff finishes " +
  'say exactly: "handoff procedure finished" as first words. if a handoff was already written ' +
  'or there is nothing to update, still say exactly "handoff procedure finished" as first words';

/** Context nearly full: recovery-only, no new work, minimal writes. */
export const CONTEXT_RECOVERY_HANDOFF_PROMPT =
  "CONTEXT-FULL RECOVERY HANDOFF ONLY. do not continue, finish, debug, test, commit, push, " +
  "stage, fix docs, or wait for agents. inspect the current conversation, task list, plans and " +
  "reports, and git status/log/diff read-only. preserve all in-flight and uncommitted work " +
  "exactly. write one short handoff for the next session into the repo's .claude/handoffs " +
  "directory (create it if missing) as a new timestamped markdown file; include project state, " +
  "next actions, blockers, exact source paths, running or background work, git branch and " +
  "status, tests run or not run, and anything the next session must not redo. do not modify any " +
  'other file. then stop. first words of the final response must be exactly: "handoff ' +
  'procedure finished". emit the marker even if a suitable handoff already exists or nothing ' +
  "changed.";

/**
 * The recycled session's opening turn: resume from the handoff, and keep the
 * ADE full-AFK continuation law — a handoff only ever names the FIRST actions
 * of a longer plan.
 */
export const SUCCESSOR_RESUME_PROMPT =
  "you are a fresh session continuing the previous one, which recycled itself at a context " +
  "threshold. read the newest handoff in .claude/handoffs, reconcile it against git status and " +
  "git log (work may have landed after it was written — never redo what a commit already " +
  "delivered), then continue exactly where it leaves off. never stop after finishing the " +
  "actions named in the handoff — whether you completed all of them or only part. a handoff " +
  "only ever surfaces the first actions of a longer plan; there is always a next action. build " +
  "the full plan and keep executing.";
