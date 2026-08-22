// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - harness manages temp state dirs on disk and reads the reactor's tiny dedupe file verbatim.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ScheduleReactor } from "../Services/ScheduleReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ScheduleReactorLive } from "./ScheduleReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const INSTANCE = ProviderInstanceId.make("claudeAgent");

describe("ScheduleReactor", () => {
  const createdDirs = new Set<string>();

  afterEach(() => {
    for (const dir of createdDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();
  });

  it.effect("tick fires a due schedule: new thread with the prompt as first message, once", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-schedule-"));
    createdDirs.add(baseDir);

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
      schedules: [
        {
          id: "sched-test",
          name: "Morning sweep",
          projectTitle: "Scheduled Project",
          prompt: "run the sweep",
          days: [0, 1, 2, 3, 4, 5, 6],
          hour: 0,
          minute: 0,
          enabled: true,
        },
      ],
    });
    const layer = ScheduleReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
      createdDirs.add(stateDir);
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reactor = yield* ScheduleReactor;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-schedule-project"),
        projectId: ProjectId.make("project-sched"),
        title: "Scheduled Project",
        workspaceRoot: NodePath.join(baseDir, "workspace"),
        defaultModelSelection: { instanceId: INSTANCE, model: "claude-sonnet-5" },
        createdAt: NOW,
      });

      yield* reactor.tick;
      yield* reactor.tick; // second pass must not double-fire

      const model = yield* snapshotQuery.getSnapshot();
      const threads = model.threads.filter(
        (thread) => String(thread.projectId) === "project-sched",
      );
      expect(threads).toHaveLength(1);
      const thread = threads[0]!;
      expect(thread.title).toBe("Morning sweep");
      expect(
        thread.messages.filter(
          (message) => message.role === "user" && message.text === "run the sweep",
        ),
      ).toHaveLength(1);

      // dedupe survives a restart via the persisted state file
      const state = JSON.parse(
        NodeFS.readFileSync(NodePath.join(stateDir, "schedule-state.json"), "utf8"),
      ) as Record<string, string>;
      expect(typeof state["sched-test"]).toBe("string");
    }).pipe(Effect.provide(layer));
  });
});
