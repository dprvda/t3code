/**
 * ClaudeSeatRotationReactor - Claude seat rotation service interface.
 *
 * Owns the background worker that reacts to usage-limit failures on Claude
 * threads whose provider instances share a continuation group, and moves the
 * thread to the next usable seat with a continuation turn.
 *
 * @module ClaudeSeatRotationReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ClaudeSeatRotationReactorShape - Service API for the seat rotation worker.
 */
export interface ClaudeSeatRotationReactorShape {
  /**
   * Start reacting to provider runtime events.
   *
   * The returned effect must be run in a scope so the worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ClaudeSeatRotationReactor - Service tag for the seat rotation worker.
 */
export class ClaudeSeatRotationReactor extends Context.Service<
  ClaudeSeatRotationReactor,
  ClaudeSeatRotationReactorShape
>()("t3/orchestration/Services/ClaudeSeatRotationReactor") {}
