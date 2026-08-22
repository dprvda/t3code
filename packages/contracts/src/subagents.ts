/**
 * Subagent transcript contracts: list a thread's on-disk subagent runs and
 * read one run's transcript. See `apps/server/src/provider/subagentTranscripts.ts`.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SubagentRunSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  parentSessionId: TrimmedNonEmptyString,
  agentType: Schema.String,
  description: Schema.String,
  model: Schema.NullOr(Schema.String),
  toolUseId: Schema.NullOr(Schema.String),
  modifiedAt: Schema.String,
  sizeBytes: Schema.Int,
});
export type SubagentRunSummary = typeof SubagentRunSummary.Type;

export const SubagentTranscriptBlock = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.String,
  // Additive (older servers omit them): structure for timeline-grade rendering.
  at: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["text", "tool_use", "tool_result"])),
  toolName: Schema.optional(Schema.String),
  toolUseId: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  fileEdit: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      oldText: Schema.String,
      newText: Schema.String,
    }),
  ),
});
export type SubagentTranscriptBlock = typeof SubagentTranscriptBlock.Type;

export const SubagentListInput = Schema.Struct({
  threadId: ThreadId,
});
export type SubagentListInput = typeof SubagentListInput.Type;

export const SubagentListResult = Schema.Struct({
  runs: Schema.Array(SubagentRunSummary),
});
export type SubagentListResult = typeof SubagentListResult.Type;

export const SubagentTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  parentSessionId: TrimmedNonEmptyString,
  agentFileId: TrimmedNonEmptyString,
});
export type SubagentTranscriptInput = typeof SubagentTranscriptInput.Type;

export const SubagentTranscriptResult = Schema.Struct({
  blocks: Schema.Array(SubagentTranscriptBlock),
});
export type SubagentTranscriptResult = typeof SubagentTranscriptResult.Type;

export class SubagentViewError extends Schema.TaggedErrorClass<SubagentViewError>()(
  "SubagentViewError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
