/**
 * ScheduleReactor - Scheduled-launch service interface (ADE schedules port).
 *
 * Owns the background loop that fires `settings.schedules`: at each due
 * schedule it creates a fresh thread in the target project with the
 * configured prompt as its first message.
 *
 * @module ScheduleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ScheduleReactorShape {
  /**
   * Start the polling loop. The returned effect must be run in a scope so
   * the worker fiber can be finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** One scheduling pass (check due, fire). Exposed for tests. */
  readonly tick: Effect.Effect<void>;
}

export class ScheduleReactor extends Context.Service<ScheduleReactor, ScheduleReactorShape>()(
  "t3/orchestration/Services/ScheduleReactor",
) {}
