// @effect-diagnostics nodeBuiltinImport:off - harness manages temp state dirs on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Clock from "effect/Clock";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import type { LimitBar } from "../../provider/claudeSeatLimits.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ClaudeSeatRotationReactor } from "../Services/ClaudeSeatRotationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  CLAUDE_SEAT_MOVE_PROMPT,
  ClaudeSeatLimits,
  ClaudeSeatRotationReactorLive,
  claudeSeatConfigDir,
} from "./ClaudeSeatRotationReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const GROUP_KEY = "claude:group:max-seats";
const SEAT_1 = ProviderInstanceId.make("claudeAgent_acct1");
const SEAT_2 = ProviderInstanceId.make("claudeAgent_acct2");
const SEAT_SOLO = ProviderInstanceId.make("claudeAgent_solo");
// two presets of the SAME account: equal home-derived continuation keys
const SEAT_PRESET_A = ProviderInstanceId.make("claudeAgent_preset_a");
const SEAT_PRESET_B = ProviderInstanceId.make("claudeAgent_preset_b");
const LIMIT_TEXT = "You’ve hit your session limit · resets 8am";

const bar = (label: string, pct: number): LimitBar => ({ label, pct, resetsAt: null });

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ClaudeSeatRotationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ClaudeSeatRotationReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of createdDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();
  });

  async function createHarness(input?: {
    /** Bars per seat config dir key ("/seat-1", "/seat-2"); missing key = unreachable meters. */
    readonly meterBars?: Record<string, LimitBar[]>;
    /** Instance thread-1 starts on. Defaults to the grouped SEAT_1. */
    readonly threadInstance?: typeof SEAT_1;
  }) {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-seat-rotation-"));
    createdDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdDirs.add(stateDir);
    // replay buffer: the reactor's stream subscription is established
    // asynchronously after start(), so late subscribers must still see
    // everything the test published
    const runtimeEventPubSub = Effect.runSync(
      PubSub.unbounded<ProviderRuntimeEvent>({ replay: 64 }),
    );
    const meterFetches: Array<{ configDir: string | null; force: boolean }> = [];

    // SEAT_1 and SEAT_2 share a continuation group; SEAT_SOLO is home-keyed.
    const claudeInfo = (instanceId: ProviderInstanceId) => ({
      instanceId,
      driverKind: ProviderDriverKind.make("claudeAgent"),
      displayName: undefined,
      enabled: true,
      continuationIdentity: {
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationKey:
          String(instanceId) === String(SEAT_SOLO)
            ? "claude:home:/seat-solo"
            : String(instanceId) === String(SEAT_PRESET_A) ||
                String(instanceId) === String(SEAT_PRESET_B)
              ? "claude:home:/shared-preset-home"
              : GROUP_KEY,
      },
    });
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) =>
        [
          String(SEAT_1),
          String(SEAT_2),
          String(SEAT_SOLO),
          String(SEAT_PRESET_A),
          String(SEAT_PRESET_B),
        ].includes(String(instanceId))
          ? Effect.succeed(claudeInfo(instanceId))
          : // unknown instances fail typed, matching the live service
            // @effect-diagnostics-next-line globalErrorInEffectFailure:off - stand-in for the live service's typed error
            (Effect.fail(new Error(`unknown instance ${String(instanceId)}`)) as never),
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const settingsLayer = ServerSettingsService.layerTest({
      providerInstances: {
        [SEAT_1]: { driver: "claudeAgent", config: { homePath: "/seat-1" } },
        [SEAT_2]: { driver: "claudeAgent", config: { homePath: "/seat-2" } },
        [SEAT_SOLO]: { driver: "claudeAgent", config: { homePath: "/seat-solo" } },
        [SEAT_PRESET_A]: { driver: "claudeAgent", config: { homePath: "/shared-preset-home" } },
        [SEAT_PRESET_B]: { driver: "claudeAgent", config: { homePath: "/shared-preset-home" } },
      } as never,
    });
    const seatLimitsLayer = Layer.succeed(ClaudeSeatLimits, {
      fetchSeatLimits: (configDir, options) => {
        meterFetches.push({ configDir, force: options?.force === true });
        const bars = configDir === null ? undefined : input?.meterBars?.[configDir];
        return Promise.resolve(bars === undefined ? null : { stale: false, bars });
      },
    });
    const layer = ClaudeSeatRotationReactorLive.pipe(
      Layer.provide(seatLimitsLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ClaudeSeatRotationReactor));

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Seat Project",
        workspaceRoot: "/tmp/seat-project",
        defaultModelSelection: { instanceId: SEAT_1, model: "claude-fable-5" },
        createdAt: NOW,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: input?.threadInstance ?? SEAT_1, model: "claude-fable-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      }),
    );

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    const emitFailedTurn = (eventId: string, errorMessage: string = LIMIT_TEXT) =>
      Effect.runPromise(
        PubSub.publish(runtimeEventPubSub, {
          type: "turn.completed",
          eventId: EventId.make(eventId),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: NOW,
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          payload: { state: "failed", errorMessage },
        } as ProviderRuntimeEvent),
      );

    const emitAssistantItem = (eventId: string, detail: string) =>
      Effect.runPromise(
        PubSub.publish(runtimeEventPubSub, {
          type: "item.completed",
          eventId: EventId.make(eventId),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: NOW,
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          itemId: RuntimeItemId.make(`item-${eventId}`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            detail,
          },
        } as unknown as ProviderRuntimeEvent),
      );

    const readModel = () => Effect.runPromise(snapshotQuery.getSnapshot());
    const readThread = async () => {
      const model = await readModel();
      const thread = model.threads.find((entry) => String(entry.id) === "thread-1");
      if (!thread) throw new Error("thread-1 missing from read model");
      return thread;
    };
    const moveMessages = async () =>
      (await readThread()).messages.filter(
        (message) => message.role === "user" && message.text === CLAUDE_SEAT_MOVE_PROMPT,
      );

    return {
      engine,
      readModel,
      readThread,
      moveMessages,
      drain: () => Effect.runPromise(reactor.drain),
      emitFailedTurn,
      emitAssistantItem,
      meterFetches,
    };
  }

  it("moves a meter-confirmed limited thread to the next seat with the continuation prompt", async () => {
    const harness = await createHarness({
      meterBars: {
        "/seat-1": [bar("5h", 100)],
        "/seat-2": [bar("5h", 12)],
      },
    });
    await harness.emitFailedTurn("evt-limit-1");
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    // the limit was confirmed with a forced fetch on the limited seat
    expect(harness.meterFetches[0]).toEqual({ configDir: "/seat-1", force: true });
    // the MOVE turn rebinds the thread to the next seat, same model
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_2));
    expect(thread.modelSelection.model).toBe("claude-fable-5");
    const activity = thread.activities.find((entry) => entry.kind === "seat-rotation.moved");
    expect(activity).toBeDefined();
    expect(activity!.payload).toMatchObject({ from: String(SEAT_1), to: String(SEAT_2) });
  });

  it("re-delivered limit events are idempotent", async () => {
    const harness = await createHarness({
      meterBars: { "/seat-1": [bar("5h", 100)], "/seat-2": [bar("5h", 12)] },
    });
    await harness.emitFailedTurn("evt-limit-1");
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    const fetchesAfterFirst = harness.meterFetches.length;
    await harness.emitFailedTurn("evt-limit-1");
    // FIFO processing: when the second delivery has run, it has re-fetched meters
    await waitFor(() => harness.meterFetches.length > fetchesAfterFirst);
    await harness.drain();

    expect(await harness.moveMessages()).toHaveLength(1);
  });

  it("ignores the limit text when fresh meters show headroom (scrollback echo)", async () => {
    const harness = await createHarness({
      meterBars: {
        "/seat-1": [bar("5h", 40)],
        "/seat-2": [bar("5h", 12)],
      },
    });
    await harness.emitFailedTurn("evt-echo-1");
    // the confirm fetch is the observable step; processing is a single worker item
    await waitFor(() => harness.meterFetches.length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_1));
    expect(await harness.moveMessages()).toHaveLength(0);
  });

  it("moves on the banner alone when meters are unreachable (hop budget path)", async () => {
    const harness = await createHarness(); // no meterBars: every fetch returns null
    await harness.emitFailedTurn("evt-unreachable-1");
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_2));
  });

  it("moves when the limit surfaces as assistant text (SDK api_error turns complete)", async () => {
    const harness = await createHarness({
      meterBars: { "/seat-1": [bar("5h", 100)], "/seat-2": [bar("5h", 12)] },
    });
    // the live-observed shape: the API error completes the turn and renders
    // as an assistant message carrying the provider's limit text
    await harness.emitAssistantItem(
      "evt-item-1",
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You’ve hit your usage limit · resets 8am"}}',
    );
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_2));
    expect(harness.meterFetches[0]).toEqual({ configDir: "/seat-1", force: true });
  });

  it("plain assistant prose never trips the scanner", async () => {
    const harness = await createHarness({
      meterBars: { "/seat-1": [bar("5h", 100)], "/seat-2": [bar("5h", 12)] },
    });
    await harness.emitAssistantItem(
      "evt-item-benign",
      "We are approaching usage limit territory, so plan carefully.",
    );
    // FIFO: a subsequent real banner acting proves the benign item was processed
    await harness.emitFailedTurn("evt-banner-after-benign");
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    await harness.drain();
    expect(await harness.moveMessages()).toHaveLength(1);
    expect(harness.meterFetches[0]).toEqual({ configDir: "/seat-1", force: true });
  });

  it("never rotates a thread on a home-keyed (ungrouped) instance", async () => {
    const harness = await createHarness({
      threadInstance: SEAT_SOLO,
      meterBars: { "/seat-solo": [bar("5h", 100)], "/seat-2": [bar("5h", 12)] },
    });
    await harness.emitFailedTurn("evt-ungrouped-1");
    // Prove the event was fully processed: drain resolves only after the
    // worker finished the enqueued item, and a subsequent identical emit plus
    // drain closes any enqueue race window.
    await harness.drain();
    await harness.emitFailedTurn("evt-ungrouped-2");
    await harness.drain();

    const thread = await harness.readThread();
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_SOLO));
    expect(await harness.moveMessages()).toHaveLength(0);
    expect(harness.meterFetches).toHaveLength(0);
  });

  it("never rotates between same-home presets (home keys are not an opt-in group)", async () => {
    const harness = await createHarness({
      threadInstance: SEAT_PRESET_A,
      meterBars: { "/shared-preset-home": [bar("5h", 100)] },
    });
    await harness.emitFailedTurn("evt-preset-1");
    await harness.drain();
    await harness.emitFailedTurn("evt-preset-2");
    await harness.drain();

    const thread = await harness.readThread();
    expect(String(thread.modelSelection.instanceId)).toBe(String(SEAT_PRESET_A));
    expect(await harness.moveMessages()).toHaveLength(0);
    // bailed at the opt-in gate: the meters were never consulted
    expect(harness.meterFetches).toHaveLength(0);
  });

  it("ignores failed turns whose error is not a limit banner", async () => {
    const harness = await createHarness({
      meterBars: { "/seat-1": [bar("5h", 100)], "/seat-2": [bar("5h", 12)] },
    });
    await harness.emitFailedTurn("evt-other-1", "The provider process crashed unexpectedly.");
    // FIFO: the follow-up banner event acting proves the crash event was processed
    await harness.emitFailedTurn("evt-banner-after");
    await waitFor(async () => (await harness.moveMessages()).length > 0);
    await harness.drain();

    // only the banner event fetched meters; the crash event never did
    expect(harness.meterFetches[0]).toEqual({ configDir: "/seat-1", force: true });
    expect(await harness.moveMessages()).toHaveLength(1);
  });

  describe("claudeSeatConfigDir", () => {
    it("reads explicit instance homes, the builtin slot, and defaults", () => {
      const settings = {
        providers: { claudeAgent: { homePath: "~/.claude-main" } },
        providerInstances: {
          [SEAT_2]: { driver: "claudeAgent", config: { homePath: "/seat-2" } },
          empty: { driver: "claudeAgent", config: { homePath: "" } },
        },
      } as never;
      expect(claudeSeatConfigDir(settings, SEAT_2)).toBe("/seat-2");
      expect(claudeSeatConfigDir(settings, ProviderInstanceId.make("empty"))).toBeNull();
      expect(
        claudeSeatConfigDir(settings, ProviderInstanceId.make("claudeAgent"))?.endsWith(
          "/.claude-main",
        ),
      ).toBe(true);
    });
  });
});
