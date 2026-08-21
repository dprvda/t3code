/**
 * Reacts to usage-limit failures on Claude threads and rotates them to the
 * next usable seat.
 *
 * Rotation is opt-in: it only engages for threads whose provider instance is a
 * `claudeAgent` instance with an explicit continuation group (see
 * `ClaudeHome.makeClaudeContinuationGroupKey`) shared by at least one other
 * enabled instance. A `turn.completed` runtime event with `state: "failed"`
 * whose error text matches the strict limit pattern is confirmed against the
 * seat's official usage meters before acting; when the meters are unreachable
 * (the normal state when a busy fleet is limited — its own polling keeps the
 * endpoint rate-limited), a per-thread hop budget bounds action on the text
 * alone. The move itself is one `thread.turn.start` dispatch with the next
 * seat's instance id and a continuation prompt — the provider command reactor
 * then restarts the session on the new instance, carrying the resume cursor,
 * because the instances share a continuation key.
 *
 * Ports the decision flow of ADE `src/main/ipc.ts` (limit banner handling) on
 * top of the policy cores in `provider/claudeSeatGuard.ts`.
 *
 * @module ClaudeSeatRotationReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  type ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  bannerFamily,
  makeClaudeSeatGuard,
  matchLimitBanner,
  meterBlocked,
  familyBlocked,
  modelFamily,
  type ClaudeSeat,
} from "../../provider/claudeSeatGuard.ts";
import {
  makeSeatLimitsFetcher,
  type LimitBar,
  type SeatLimitsFetcher,
} from "../../provider/claudeSeatLimits.ts";
import type { ProviderInstanceRoutingInfo } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  ClaudeSeatRotationReactor,
  type ClaudeSeatRotationReactorShape,
} from "../Services/ClaudeSeatRotationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const CLAUDE_GROUP_KEY_PREFIX = "claude:group:";

/**
 * The continuation prompt sent as the moved thread's next turn. Ported
 * verbatim from ADE's MOVE_PROMPT — the wording is what keeps the agent from
 * replanning or summarizing after the hop.
 */
export const CLAUDE_SEAT_MOVE_PROMPT =
  "you were interrupted by a usage limit and moved to another account. continue exactly where " +
  "you stopped: finish the in-flight task, no re-planning, no summarizing.";

/**
 * ClaudeSeatLimits - Injectable seat meter access for the rotation reactor.
 * The live layer reads seat credentials and calls the official usage endpoint;
 * tests substitute a scripted fetcher.
 */
export class ClaudeSeatLimits extends Context.Service<ClaudeSeatLimits, SeatLimitsFetcher>()(
  "t3/orchestration/Layers/ClaudeSeatRotationReactor/ClaudeSeatLimits",
) {
  static readonly layer = Layer.sync(ClaudeSeatLimits, () => makeSeatLimitsFetcher());
}

/**
 * The Claude config blob (`homePath`) for an instance, from wherever it lives:
 * explicit instances carry it in `providerInstances`, the built-in
 * `claudeAgent` slot in `providers.claudeAgent`. The blob is `Schema.Unknown`
 * at the settings layer, so the read is defensive. Returns the seat config dir
 * (null = default `~/.claude`).
 */
export function claudeSeatConfigDir(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): string | null {
  const explicit = settings.providerInstances[instanceId];
  const config: unknown =
    explicit !== undefined
      ? explicit.config
      : String(instanceId) === "claudeAgent"
        ? settings.providers.claudeAgent
        : undefined;
  if (!Predicate.isObject(config)) return null;
  const homePath = (config as { homePath?: unknown }).homePath;
  if (!Predicate.isString(homePath) || homePath.trim().length === 0) return null;
  return expandHomePath(homePath.trim());
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;
  const seatLimits = yield* ClaudeSeatLimits;
  const guard = makeClaudeSeatGuard();

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const fetchLimits = (configDir: string | null, force: boolean) =>
    Effect.promise(() => seatLimits.fetchSeatLimits(configDir, { force })).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

  const appendRotationActivity = (input: {
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
        Effect.map((uuid) => CommandId.make(`server:claude-seat-rotation:${uuid}`)),
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

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    if (event.payload.state !== "failed") return;
    const errorMessage = event.payload.errorMessage;
    if (errorMessage === undefined) return;
    const banner = matchLimitBanner(errorMessage);
    if (banner === null) return;

    const threadId = ThreadId.make(String(event.threadId));
    const thread = yield* resolveThread(threadId);
    if (!thread) return;
    const currentInstanceId = thread.modelSelection.instanceId;
    const currentInfo = yield* providerService
      .getInstanceInfo(currentInstanceId)
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    if (currentInfo === undefined || currentInfo.driverKind !== "claudeAgent") return;
    const groupKey = currentInfo.continuationIdentity.continuationKey;
    // Rotation is opt-in via continuation groups; home-keyed instances never rotate.
    if (!groupKey.startsWith(CLAUDE_GROUP_KEY_PREFIX)) return;

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );
    if (settings === undefined) return;
    // Candidate seats: every configured Claude instance (explicit map entries
    // plus the built-in `claudeAgent` slot), narrowed to enabled instances in
    // the same continuation group via the routing info the registry derived.
    const candidateIds = new Set<string>(["claudeAgent"]);
    for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
      if (entry.driver === "claudeAgent") candidateIds.add(instanceId);
    }
    const groupInstances: ProviderInstanceRoutingInfo[] = [];
    for (const candidateId of candidateIds) {
      const info = yield* providerService
        .getInstanceInfo(candidateId as ProviderInstanceId)
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
      if (
        info !== undefined &&
        info.enabled &&
        info.driverKind === "claudeAgent" &&
        info.continuationIdentity.continuationKey === groupKey
      ) {
        groupInstances.push(info);
      }
    }
    if (groupInstances.length < 2) return;
    const seats: ClaudeSeat[] = groupInstances.map((instance) => ({
      name: String(instance.instanceId),
      configDir: claudeSeatConfigDir(settings, instance.instanceId),
    }));
    const currentSeat = seats.find((seat) => seat.name === String(currentInstanceId));
    if (currentSeat === undefined) return;

    const turnId = event.turnId === undefined ? null : TurnId.make(String(event.turnId));
    const wantModel = thread.modelSelection.model;
    const family = bannerFamily(banner);

    // Confirm against the official meters before acting — replayed or echoed
    // limit text must not cascade moves through every seat.
    const confirmed = yield* fetchLimits(currentSeat.configDir, true);
    let reason: string;
    if (confirmed === null || confirmed.stale) {
      // Meters unreachable: act on the text alone, bounded by the hop budget.
      if (!guard.allowHop(String(threadId))) {
        yield* appendRotationActivity({
          threadId,
          turnId,
          tone: "info",
          kind: "seat-rotation.suspect",
          summary: "Usage-limit text seen but hop budget exhausted",
          payload: { seat: currentSeat.name, banner },
          createdAt: yield* nowIso,
        });
        return;
      }
      if (family !== null && family === modelFamily(wantModel)) {
        guard.markFamilyLimited(currentSeat.name, family);
        reason = `${family} cap (limit message, meters unreachable)`;
      } else {
        guard.markLimited(currentSeat.name, "limit message (meters unreachable)");
        reason = "limit message (meters unreachable)";
      }
    } else {
      const block = meterBlocked(confirmed.bars);
      if (block !== null) {
        guard.markLimited(currentSeat.name, `${block} limit (meter-confirmed)`);
        reason = `${block} limit (meter-confirmed)`;
      } else if (familyBlocked(confirmed.bars, wantModel)) {
        guard.markFamilyLimited(currentSeat.name, modelFamily(wantModel));
        reason = `${wantModel} weekly cap (meter-confirmed)`;
      } else {
        // Meters show headroom: stale echo of an old banner, ignore.
        return;
      }
    }

    const barsBySeat = new Map<string, LimitBar[] | null>();
    for (const seat of seats) {
      const limits = yield* fetchLimits(seat.configDir, false);
      barsBySeat.set(seat.name, limits !== null && !limits.stale ? limits.bars : null);
    }
    const pick = guard.pickUsable(seats, (seat) => barsBySeat.get(seat.name) ?? null, wantModel);
    if (pick === null || pick.seat.name === currentSeat.name) {
      yield* appendRotationActivity({
        threadId,
        turnId,
        tone: "error",
        kind: "seat-rotation.exhausted",
        summary: "Usage limit hit and no other seat is usable",
        payload: { seat: currentSeat.name, reason, banner },
        createdAt: yield* nowIso,
      });
      return;
    }

    const createdAt = yield* nowIso;
    yield* appendRotationActivity({
      threadId,
      turnId,
      tone: "info",
      kind: "seat-rotation.moved",
      summary: `Moved to ${pick.seat.name} after usage limit on ${currentSeat.name}`,
      payload: {
        from: currentSeat.name,
        to: pick.seat.name,
        model: pick.model,
        swapped: pick.swapped,
        reason,
      },
      createdAt,
    });
    // Deterministic ids per source event: engine command receipts make a
    // redelivered runtime event idempotent instead of double-moving. The meta
    // update makes the rebind durable in the read model (`thread.turn.start`
    // does not project its modelSelection onto the thread) so a later limit
    // event resolves the thread's current seat correctly.
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(`server:claude-seat-rotation:${event.eventId}:meta`),
      threadId,
      modelSelection: {
        ...thread.modelSelection,
        instanceId: pick.seat.name as ProviderInstanceId,
        model: pick.model,
      },
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:claude-seat-rotation:${event.eventId}`),
      threadId,
      message: {
        messageId: MessageId.make(`claude-seat-rotation:${event.eventId}`),
        role: "user",
        text: CLAUDE_SEAT_MOVE_PROMPT,
        attachments: [],
      },
      modelSelection: {
        ...thread.modelSelection,
        instanceId: pick.seat.name as ProviderInstanceId,
        model: pick.model,
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    });
  });

  const processRuntimeEventSafely = (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) =>
    processRuntimeEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("claude seat rotation reactor failed to process event", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processRuntimeEventSafely);

  const start: ClaudeSeatRotationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ClaudeSeatRotationReactorShape;
});

export const ClaudeSeatRotationReactorLive = Layer.effect(ClaudeSeatRotationReactor, make);
