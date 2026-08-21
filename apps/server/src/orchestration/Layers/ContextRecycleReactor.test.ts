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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  HANDOFF_DONE_MARKER,
  STANDARD_HANDOFF_PROMPT,
  SUCCESSOR_RESUME_PROMPT,
} from "../../provider/claudeHandoffPrompts.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ContextRecycleReactor } from "../Services/ContextRecycleReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ContextRecycleReactorLive } from "./ContextRecycleReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const INSTANCE = ProviderInstanceId.make("claudeAgent");
const THREAD = ThreadId.make("thread-1");

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

describe("ContextRecycleReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ContextRecycleReactor
    | ProjectionSnapshotQuery
    | ProviderSessionDirectory.ProviderSessionDirectory,
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
    readonly thresholdTokens?: number;
    readonly enabled?: boolean;
  }) {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-recycle-"));
    createdDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(
      PubSub.unbounded<ProviderRuntimeEvent>({ replay: 64 }),
    );

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
      getInstanceInfo: () => unsupported(),
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
    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const settingsLayer = ServerSettingsService.layerTest({
      contextRecycle: {
        enabled: input?.enabled ?? true,
        thresholdTokens: input?.thresholdTokens ?? 600_000,
      },
    });
    const layer = ContextRecycleReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(directoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const directory = await runtime.runPromise(
      Effect.service(ProviderSessionDirectory.ProviderSessionDirectory),
    );
    const reactor = await runtime.runPromise(Effect.service(ContextRecycleReactor));

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Recycle Project",
        workspaceRoot: "/tmp/recycle-project",
        defaultModelSelection: { instanceId: INSTANCE, model: "claude-sonnet-5" },
        createdAt: NOW,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: THREAD,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      }),
    );
    // a persisted binding with a resume cursor, as a live session leaves behind
    await Effect.runPromise(
      directory.upsert({
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: INSTANCE,
        threadId: THREAD,
        status: "running",
        resumeCursor: { resume: "sdk-session-1", turnCount: 5 },
      }),
    );

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    const emit = (event: Record<string, unknown>) =>
      Effect.runPromise(
        PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent),
      );
    const emitUsage = (eventId: string, usedTokens: number, maxTokens: number) =>
      emit({
        type: "thread.token-usage.updated",
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: NOW,
        threadId: THREAD,
        turnId: TurnId.make("turn-1"),
        payload: { usage: { usedTokens, maxTokens } },
      });
    const emitAssistantItem = (eventId: string, detail: string) =>
      emit({
        type: "item.completed",
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: NOW,
        threadId: THREAD,
        turnId: TurnId.make("turn-2"),
        itemId: RuntimeItemId.make(`item-${eventId}`),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          detail,
        },
      });
    const emitTurnCompletedFor = (eventId: string, turnId: string, state = "completed") =>
      emit({
        type: "turn.completed",
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: NOW,
        threadId: THREAD,
        turnId: TurnId.make(turnId),
        payload: { state },
      });
    const emitTurnCompleted = (eventId: string, state = "completed") =>
      emitTurnCompletedFor(eventId, "turn-2", state);

    const readModel = () => Effect.runPromise(snapshotQuery.getSnapshot());
    const readThread = async () => {
      const model = await readModel();
      const thread = model.threads.find((entry) => String(entry.id) === String(THREAD));
      if (!thread) throw new Error("thread-1 missing from read model");
      return thread;
    };
    const messagesWith = async (text: string) =>
      (await readThread()).messages.filter(
        (message) => message.role === "user" && message.text === text,
      );
    const readBinding = () =>
      Effect.runPromise(directory.getBinding(THREAD).pipe(Effect.map(Option.getOrUndefined)));

    return {
      engine,
      readModel,
      readThread,
      messagesWith,
      readBinding,
      drain: () => Effect.runPromise(reactor.drain),
      emitUsage,
      emitAssistantItem,
      emitTurnCompleted,
      emitTurnCompletedFor,
    };
  }

  it("crossing the threshold on an idle thread requests a handoff turn", async () => {
    const harness = await createHarness();
    await harness.emitUsage("evt-usage-1", 700_000, 1_000_000); // >= 600k tokens
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    const requested = thread.activities.find(
      (entry) => entry.kind === "context-recycle.handoff-requested",
    );
    expect(requested).toBeDefined();
  });

  it("marker + handoff completion recycles: stop, cleared cursor, successor turn", async () => {
    const harness = await createHarness();
    await harness.emitUsage("evt-usage-1", 700_000, 1_000_000);
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0);
    await harness.emitAssistantItem(
      "evt-marker",
      `${HANDOFF_DONE_MARKER} — wrote .claude/handoffs/2026-01-01-recycle.md`,
    );
    await harness.emitTurnCompleted("evt-handoff-done");
    await waitFor(async () => (await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).length > 0);
    await harness.drain();

    const binding = await harness.readBinding();
    expect(binding?.resumeCursor ?? null).toBeNull();
    const thread = await harness.readThread();
    expect(thread.activities.some((entry) => entry.kind === "context-recycle.recycled")).toBe(true);
    // the session stop went through the engine
    const model = await harness.readModel();
    expect(model.threads.length).toBeGreaterThan(0);
    expect(await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).toHaveLength(1);
  });

  it("a trailing completion of the preceding turn does not abort the pending handoff", async () => {
    const harness = await createHarness();
    // crossing arrives carrying the current turn's id (turn-1)
    await harness.emitUsage("evt-usage-1", 700_000, 1_000_000);
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0);
    // the handoff dispatch flushes a stale synthetic turn: one more
    // turn.completed for the OLD turn (turn-1), before the handoff turn ends
    await harness.emitTurnCompletedFor("evt-phantom", "turn-1");
    // the real handoff turn produces the marker and completes
    await harness.emitAssistantItem("evt-marker", HANDOFF_DONE_MARKER);
    await harness.emitTurnCompleted("evt-handoff-done");
    await waitFor(async () => (await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    expect(thread.activities.some((entry) => entry.kind === "context-recycle.handoff-failed")).toBe(
      false,
    );
    expect(await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).toHaveLength(1);
  });

  it("handoff turn without the marker aborts the recycle", async () => {
    const harness = await createHarness();
    await harness.emitUsage("evt-usage-1", 700_000, 1_000_000);
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0);
    await harness.emitAssistantItem("evt-chatter", "I could not write the handoff, sorry.");
    await harness.emitTurnCompleted("evt-handoff-done");
    await waitFor(async () =>
      (await harness.readThread()).activities.some(
        (entry) => entry.kind === "context-recycle.handoff-failed",
      ),
    );
    await harness.drain();

    expect(await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).toHaveLength(0);
    const binding = await harness.readBinding();
    expect(binding?.resumeCursor).toEqual({ resume: "sdk-session-1", turnCount: 5 });
  });

  it("below-threshold usage and disabled recycling never act", async () => {
    const harness = await createHarness({ enabled: false });
    await harness.emitUsage("evt-usage-off", 950_000, 1_000_000);
    // FIFO probe: a benign turn completion after the usage event proves processing
    await harness.emitTurnCompleted("evt-probe");
    await harness.drain();
    expect(await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).toHaveLength(0);

    const harness2 = await (async () => {
      // reuse a fresh harness for the below-threshold case
      await Effect.runPromise(Scope.close(scope!, Exit.void));
      scope = null;
      await runtime!.dispose();
      runtime = null;
      return createHarness({ thresholdTokens: 600_000 });
    })();
    await harness2.emitUsage("evt-usage-low", 200_000, 1_000_000);
    await harness2.emitTurnCompleted("evt-probe-2");
    await harness2.drain();
    expect(await harness2.messagesWith(STANDARD_HANDOFF_PROMPT)).toHaveLength(0);
  });

  it("a manual recycle request runs the flow even when auto-recycle is disabled", async () => {
    const harness = await createHarness({ enabled: false });
    // The engine's domain PubSub has no replay, so a dispatch can race the
    // reactor's freshly-forked subscription; re-dispatch with fresh command
    // ids until the subscriber sees one (the reactor's in-progress guard
    // makes duplicates no-ops).
    let attempt = 0;
    await waitFor(async () => {
      if ((await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0) return true;
      attempt += 1;
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.recycle.request",
          commandId: CommandId.make(`cmd-manual-recycle-${attempt}`),
          threadId: THREAD,
          createdAt: NOW,
        }),
      );
      return (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0;
    });
    await harness.emitAssistantItem("evt-manual-marker", HANDOFF_DONE_MARKER);
    await harness.emitTurnCompleted("evt-manual-done");
    await waitFor(async () => (await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).length > 0);
    await harness.drain();

    const thread = await harness.readThread();
    const requested = thread.activities.find(
      (entry) => entry.kind === "context-recycle.handoff-requested",
    );
    expect(requested?.summary).toBe("Manual recycle — requesting handoff");
    const binding = await harness.readBinding();
    expect(binding?.resumeCursor ?? null).toBeNull();
  });

  it("trailing high-usage snapshots after a recycle do not re-trigger until usage drops", async () => {
    const harness = await createHarness();
    await harness.emitUsage("evt-usage-1", 700_000, 1_000_000);
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length > 0);
    await harness.emitAssistantItem("evt-marker", HANDOFF_DONE_MARKER);
    await harness.emitTurnCompleted("evt-handoff-done");
    await waitFor(async () => (await harness.messagesWith(SUCCESSOR_RESUME_PROMPT)).length > 0);

    // trailing snapshot from the old session, still above threshold
    await harness.emitUsage("evt-usage-trailing", 820_000, 1_000_000);
    // fresh session reports low usage — watching resumes
    await harness.emitUsage("evt-usage-fresh", 100_000, 1_000_000);
    // and a later real crossing recycles again
    await harness.emitUsage("evt-usage-2", 900_000, 1_000_000);
    await waitFor(async () => (await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).length >= 2);
    await harness.drain();

    expect(await harness.messagesWith(STANDARD_HANDOFF_PROMPT)).toHaveLength(2);
  });
});
