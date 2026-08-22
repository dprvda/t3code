/**
 * Claude rotation-seat visibility: every claudeAgent instance that opted into
 * seat rotation (an explicit continuation group), with its official usage
 * meters and a derived READY / COOLING / UNKNOWN state. Powers the accounts
 * HOT/COOLING view. See `apps/server/src/provider/claudeSeats.ts`.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ClaudeSeatBar = Schema.Struct({
  label: Schema.String,
  pct: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
});
export type ClaudeSeatBar = typeof ClaudeSeatBar.Type;

export const ClaudeSeatRow = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  displayName: Schema.NullOr(Schema.String),
  /** The rotation (continuation) group this seat belongs to. */
  group: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  /**
   * ready = meters show headroom; cooling = a meter is at its cap (waiting
   * for the window reset); unknown = meters unreachable or credential stale.
   */
  state: Schema.Literals(["ready", "cooling", "unknown"]),
  /** The capped meter's label when cooling (e.g. "5h" or "wk opus"). */
  blockedLabel: Schema.NullOr(Schema.String),
  /** When the capped meter resets, when cooling and known. */
  resetsAt: Schema.NullOr(Schema.String),
  bars: Schema.Array(ClaudeSeatBar),
});
export type ClaudeSeatRow = typeof ClaudeSeatRow.Type;

export const ClaudeSeatsInput = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type ClaudeSeatsInput = typeof ClaudeSeatsInput.Type;

export const ClaudeSeatsResult = Schema.Struct({
  seats: Schema.Array(ClaudeSeatRow),
});
export type ClaudeSeatsResult = typeof ClaudeSeatsResult.Type;

export class ClaudeSeatsError extends Schema.TaggedErrorClass<ClaudeSeatsError>()(
  "ClaudeSeatsError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
