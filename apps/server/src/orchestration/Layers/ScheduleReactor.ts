/**
 * Fires `settings.schedules` (ADE schedules port): a 30 s polling loop that,
 * for each due schedule, creates a FRESH thread in the target project (found
 * by title) and starts its first turn with the configured prompt — with the
 * workspace's launch-docs read-first block prefixed, same as a hand-launched
 * thread. Once-per-day dedupe is persisted to `<stateDir>/schedule-state.json`
 * so a restart after a fire does not refire.
 *
 * @module ScheduleReactor
 */
// @effect-diagnostics nodeBuiltinImport:off - tiny JSON state file in the server's own state dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ScheduledLaunch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { launchDocsPrefix } from "../../workspace/launchDocs.ts";
import { dueSchedules, localIsoDay } from "../scheduleLogic.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ScheduleReactor, type ScheduleReactorShape } from "../Services/ScheduleReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const POLL_INTERVAL = "30 seconds" as const;

function readState(file: string): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

function writeState(file: string, state: ReadonlyMap<string, string>): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`);
  } catch {
    /* best effort — a lost dedupe file only risks one duplicate launch */
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const config = yield* ServerConfig;

  const stateFile = NodePath.join(config.stateDir, "schedule-state.json");
  const lastFiredDayById = readState(stateFile);

  const markFired = (schedule: ScheduledLaunch, day: string) => {
    lastFiredDayById.set(schedule.id, day);
    writeState(stateFile, lastFiredDayById);
  };

  const fire = Effect.fnUntraced(function* (schedule: ScheduledLaunch, day: string) {
    // Mark first: a failing fire must not retry every 30 s all day.
    markFired(schedule, day);
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const project = snapshot.projects.find((entry) => entry.title === schedule.projectTitle);
    if (project === undefined) {
      yield* Effect.logWarning("schedule target project not found", {
        scheduleId: schedule.id,
        projectTitle: schedule.projectTitle,
      });
      return;
    }
    const modelSelection = project.defaultModelSelection;
    if (modelSelection === null) {
      yield* Effect.logWarning("schedule target project has no default model", {
        scheduleId: schedule.id,
        projectTitle: schedule.projectTitle,
      });
      return;
    }
    const threadId = ThreadId.make(yield* randomUUID);
    const createdAt = yield* nowIso;
    const title =
      schedule.name.trim().length > 0
        ? schedule.name.trim()
        : `Scheduled: ${schedule.prompt.slice(0, 60)}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`server:schedule:create:${schedule.id}:${day}`),
      threadId,
      projectId: ProjectId.make(String(project.id)),
      title,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    // Same read-first block a hand-launched thread gets; never blocks a fire.
    const prefix = launchDocsPrefix(project.workspaceRoot) ?? "";
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:schedule:turn:${schedule.id}:${day}`),
      threadId,
      message: {
        messageId: MessageId.make(`schedule:${schedule.id}:${day}`),
        role: "user",
        text: prefix + schedule.prompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: yield* nowIso,
    });
    yield* Effect.logInfo("scheduled launch fired", {
      scheduleId: schedule.id,
      threadId: String(threadId),
      projectTitle: schedule.projectTitle,
    });
  });

  const tick: ScheduleReactorShape["tick"] = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );
    if (settings === undefined || settings.schedules.length === 0) return;
    const now = DateTime.toDate(yield* DateTime.now);
    const day = localIsoDay(now);
    for (const schedule of dueSchedules(settings.schedules, now, lastFiredDayById)) {
      yield* fire(schedule, day);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning("schedule reactor tick failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.asVoid,
  );

  const start: ScheduleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.asVoid));
  });

  return {
    start,
    tick,
  } satisfies ScheduleReactorShape;
});

export const ScheduleReactorLive = Layer.effect(ScheduleReactor, make);
