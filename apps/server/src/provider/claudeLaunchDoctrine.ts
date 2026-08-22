/**
 * Launch doctrine (ADE port): the owner's standing full-AFK authority grant,
 * appended to the system prompt of EVERY session this server launches, plus a
 * router-lane addendum for sessions on routed (non-Anthropic) models. It is
 * system-prompt law rather than repo-doc text so the model treats it as
 * harness truth: the failure it exists to kill is an agent that finishes the
 * actions a handoff happens to name and then stops, when a handoff only ever
 * surfaces the FIRST actions of a longer plan.
 *
 * Companion of `claudeHandoffPrompts.ts` (the recycle-time half of the same
 * law); the wording of the authority block is ADE's, kept verbatim.
 */

export const AFK_AUTHORITY = `# Full-AFK authority (owner standing grant)

Never stop after finishing the actions named in a handoff — whether you completed ALL of them or
only PART. A launch prompt and a handoff both surface only the FIRST actions, never the whole plan;
there is always a next action. Build the full autonomous plan and keep executing across sessions.

Resolve interpretation forks yourself and record each ruling IN THE SPEC, not only in code.

Blocked on an owner-gated item? Ask via Signet to the owner's Telegram and continue on everything
else. Never idle. Never auto-pause. The only exception is an explicit owner instruction to stop
after a specific action.

When you are asked to hand off, transmit these same words and this same authority to the next
session — handoff after handoff, indefinitely. A handoff that does not carry full-AFK authority
forward is incomplete.
`;

const ROUTED_LANE_DOCTRINE = `
# Routed-model lane

This session runs a routed (non-Anthropic) model through the local router; Claude Code stays the
harness. Rules:
- Every Agent call and every Workflow \`agent()\` call sets \`model\` explicitly. Never inherit
  default. Routed (GPT) ids stay bare — their context window is declared by the instance
  configuration (CLAUDE_CODE_MAX_CONTEXT_TOKENS), and a '[1m]' suffix would wrongly claim 1M and
  break auto-compaction.
- Each delegated agent receives all context it needs: files, goal, constraints, and acceptance
  check.
- A delegated brain cannot delegate again. Do not build nested delegation.
- Proof is the runtime model, never the requested label: if the Agents panel's model column
  disagrees with what you asked for, treat the run as unrouted and say so.
`;

/** True for model ids that run through the router lane (non-claude ids). */
export function isRoutedModelId(model: string | undefined): boolean {
  return model !== undefined && model.trim() !== "" && !model.trim().startsWith("claude");
}

/** The system-prompt append for a session launch. */
export function launchDoctrine(options: { readonly routed: boolean }): string {
  return options.routed ? AFK_AUTHORITY + ROUTED_LANE_DOCTRINE : AFK_AUTHORITY;
}
