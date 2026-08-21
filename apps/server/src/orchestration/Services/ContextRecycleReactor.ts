/**
 * ContextRecycleReactor - Context recycle service interface.
 *
 * Owns the background worker that watches thread context usage, requests a
 * handoff at the configured threshold, and restarts the provider session
 * fresh from the handoff.
 *
 * @module ContextRecycleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ContextRecycleReactorShape - Service API for the context recycle worker.
 */
export interface ContextRecycleReactorShape {
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
 * ContextRecycleReactor - Service tag for the context recycle worker.
 */
export class ContextRecycleReactor extends Context.Service<
  ContextRecycleReactor,
  ContextRecycleReactorShape
>()("t3/orchestration/Services/ContextRecycleReactor") {}
