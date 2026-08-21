/**
 * Watches thread context usage and recycles the provider session before the
 * context fills: at the configured threshold it asks the running agent for a
 * handoff, waits for the completion marker, then stops the session, clears
 * the persisted resume state, and starts a fresh session that resumes from
 * the handoff file.
 *
 * Exists because provider-side auto-compaction is unreliable for routed
 * models: `compactsAutomatically` is reported but does not hold there, so the
 * server owns the recycle. The flow is turn-based — a handoff request can
 * only be dispatched between turns, so a threshold crossing observed during a
 * running turn arms the recycle and the next `turn.completed` fires it.
 *
 * Ports the recycle-at-ctx% design from ADE (recycle threshold + handoff
 * prompt + fresh-session resume), reimplemented over runtime telemetry
 * instead of transcript parsing.
 *
 * @module ContextRecycleReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import {
  HANDOFF_DONE_MARKER,
  STANDARD_HANDOFF_PROMPT,
  SUCCESSOR_RESUME_PROMPT,
} from "../../provider/claudeHandoffPrompts.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  ContextRecycleReactor,
  type ContextRecycleReactorShape,
} from "../Services/ContextRecycleReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type RecycleRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "thread.token-usage.updated" } | { type: "item.completed" } | { type: "turn.completed" }
>;

type RecycleDomainEvent = Extract<OrchestrationEvent, { type: "thread.recycle-requested" }>;

type RecycleInput =
  | { readonly source: "runtime"; readonly event: RecycleRuntimeEvent }
  | { readonly source: "domain"; readonly event: RecycleDomainEvent };

type RecyclePhase =
  | { readonly phase: "armed"; readonly pct: number }
  | {
      readonly phase: "awaiting-handoff";
      readonly pct: number;
      markerSeen: boolean;
      // The turn the thread was on when the handoff was requested. Sending
      // the handoff turn can flush a stale synthetic turn as one more
      // `turn.completed` for the OLD turn (ClaudeAdapter.sendTurn), which
      // must not be mistaken for the handoff turn ending.
      readonly precedingTurnId: string | null;
    }
  // After a recycle, usage snapshots from the OLD session can still trail in
  // above the threshold; hold until a snapshot from the fresh session lands
  // below it, then resume watching.
  | { readonly phase: "cooldown" };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettingsService;

  const states = new Map<string, RecyclePhase>();

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const appendRecycleActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: randomUUID.pipe(
        Effect.map((uuid) => CommandId.make(`server:context-recycle:${uuid}`)),
      ),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const dispatchTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly idTag: string;
    readonly text: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) return false;
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:context-recycle:${input.idTag}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`context-recycle:${input.idTag}`),
        role: "user",
        text: input.text,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    });
    return true;
  });

  const requestHandoff = Effect.fnUntraced(function* (
    threadId: ThreadId,
    pct: number,
    causeEventId: string,
    turnId: TurnId | null,
  ) {
    states.set(String(threadId), {
      phase: "awaiting-handoff",
      pct,
      markerSeen: false,
      precedingTurnId: turnId === null ? null : String(turnId),
    });
    yield* appendRecycleActivity({
      threadId,
      turnId,
      tone: "info",
      kind: "context-recycle.handoff-requested",
      summary:
        pct < 0
          ? "Manual recycle — requesting handoff"
          : `Context at ${Math.round(pct / 1000)}k tokens — requesting handoff`,
      payload: { pct },
      createdAt: yield* nowIso,
    });
    const dispatched = yield* dispatchTurn({
      threadId,
      idTag: `handoff:${causeEventId}`,
      text: STANDARD_HANDOFF_PROMPT,
    });
    if (!dispatched) states.delete(String(threadId));
  });

  const finalizeRecycle = Effect.fnUntraced(function* (
    threadId: ThreadId,
    pct: number,
    causeEventId: string,
    turnId: TurnId | null,
  ) {
    // Stop the session, then null the persisted resume state so the
    // successor turn starts a genuinely fresh provider conversation. The
    // stop's own persistence keeps an existing cursor, so clearing after the
    // dispatch converges regardless of processing order.
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(`server:context-recycle:stop:${causeEventId}`),
      threadId,
      createdAt,
    });
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (binding !== undefined && binding.providerInstanceId !== undefined) {
      yield* directory.upsert({
        threadId,
        provider: binding.provider,
        providerInstanceId: binding.providerInstanceId,
        resumeCursor: null,
      });
    }
    yield* appendRecycleActivity({
      threadId,
      turnId,
      tone: "info",
      kind: "context-recycle.recycled",
      summary: "Handoff written — restarting session fresh from it",
      payload: { pct },
      createdAt,
    });
    yield* dispatchTurn({
      threadId,
      idTag: `resume:${causeEventId}`,
      text: SUCCESSOR_RESUME_PROMPT,
    });
    states.set(String(threadId), { phase: "cooldown" });
  });

  // Manual recycle: skip the enabled/threshold gate — the user asked for it.
  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: RecycleDomainEvent) {
    const payload = event.payload as { threadId: string };
    const threadKey = String(payload.threadId);
    const threadId = ThreadId.make(threadKey);
    const existing = states.get(threadKey);
    if (existing !== undefined && existing.phase !== "cooldown") return; // already in progress
    const thread = yield* resolveThread(threadId);
    if (!thread) return;
    if (thread.latestTurn?.state === "running") {
      states.set(threadKey, { phase: "armed", pct: -1 });
      return;
    }
    yield* requestHandoff(threadId, -1, String(event.eventId), null);
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: RecycleRuntimeEvent,
  ) {
    const threadKey = String(event.threadId);
    const threadId = ThreadId.make(threadKey);
    const turnId = event.turnId === undefined ? null : TurnId.make(String(event.turnId));

    if (event.type === "thread.token-usage.updated") {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.option,
        Effect.map(Option.getOrUndefined),
      );
      if (settings === undefined || !settings.contextRecycle.enabled) return;
      const { usedTokens, maxTokens } = event.payload.usage;
      if (usedTokens === undefined || usedTokens <= 0) return;
      // Absolute token threshold, plus a fixed 90%-of-window fallback so
      // models with windows smaller than the threshold still recycle.
      const overThreshold =
        usedTokens >= settings.contextRecycle.thresholdTokens ||
        (maxTokens !== undefined && maxTokens > 0 && usedTokens / maxTokens >= 0.9);
      const existing = states.get(threadKey);
      if (existing?.phase === "cooldown") {
        if (!overThreshold) states.delete(threadKey);
        return;
      }
      if (existing !== undefined) return;
      if (!overThreshold) return;
      const thread = yield* resolveThread(threadId);
      if (!thread) return;
      if (thread.latestTurn?.state === "running") {
        // can't inject a turn mid-turn: arm, fire on the turn boundary
        states.set(threadKey, { phase: "armed", pct: usedTokens });
        return;
      }
      yield* requestHandoff(threadId, usedTokens, String(event.eventId), turnId);
      return;
    }

    if (event.type === "item.completed") {
      const state = states.get(threadKey);
      if (state === undefined || state.phase !== "awaiting-handoff") return;
      if (event.payload.itemType !== "assistant_message") return;
      const detail = (event.payload as { detail?: unknown }).detail;
      if (typeof detail !== "string") return;
      if (detail.trimStart().toLowerCase().startsWith(HANDOFF_DONE_MARKER)) {
        state.markerSeen = true;
      }
      return;
    }

    // turn.completed
    const state = states.get(threadKey);
    if (state === undefined || state.phase === "cooldown") return;
    if (state.phase === "armed") {
      if (event.payload.state !== "completed") {
        // interrupted/failed/cancelled turn: stand down, the thread is not in
        // a state where an injected handoff turn is safe
        states.delete(threadKey);
        return;
      }
      yield* requestHandoff(threadId, state.pct, String(event.eventId), turnId);
      return;
    }
    // awaiting-handoff: a completion for the PRECEDING turn (a stale
    // synthetic turn flushed by the handoff dispatch) is not the handoff
    // turn ending — ignore it and keep waiting
    if (
      state.precedingTurnId !== null &&
      event.turnId !== undefined &&
      String(event.turnId) === state.precedingTurnId
    ) {
      return;
    }
    if (event.payload.state !== "completed" || !state.markerSeen) {
      states.delete(threadKey);
      yield* appendRecycleActivity({
        threadId,
        turnId,
        tone: "error",
        kind: "context-recycle.handoff-failed",
        summary: "Handoff turn ended without the completion marker — recycle aborted",
        payload: { pct: state.pct, turnState: event.payload.state },
        createdAt: yield* nowIso,
      });
      return;
    }
    yield* finalizeRecycle(threadId, state.pct, String(event.eventId), turnId);
  });

  const processInput = (input: RecycleInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RecycleInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("context recycle reactor failed to process event", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ContextRecycleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "thread.token-usage.updated" &&
          event.type !== "item.completed" &&
          event.type !== "turn.completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.recycle-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event: event as RecycleDomainEvent });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ContextRecycleReactorShape;
});

export const ContextRecycleReactorLive = Layer.effect(ContextRecycleReactor, make);
