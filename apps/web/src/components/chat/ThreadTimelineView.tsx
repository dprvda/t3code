/**
 * ThreadTimelineView: the main chat's exact timeline rendering (MessagesTimeline
 * over ChatView's derivation pipeline) for read-mostly surfaces — grid panes
 * and subagent transcripts — so every session feed shares ONE design system.
 * Interactive chat affordances (turn diffs, checkpoint reverts, image
 * lightbox) are stubbed off; reading, tool-group lines and inline diffs are
 * identical to the chat.
 */
import { type LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, SubagentTranscriptBlock, ThreadId, TurnId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo, useMemo, useRef } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  deriveTimelineEntries,
  deriveTurnPlans,
  deriveWorkLogEntries,
  type TimelineEntry,
} from "../../session-logic";
import { useThreadDetail, useThreadShell } from "../../state/entities";
import type { TurnDiffSummary } from "../../types";
import type { MessageId } from "@t3tools/contracts";
import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineLatestTurn } from "./MessagesTimeline.logic";
import { deriveSubagentTimelineEntries } from "./ThreadTimelineView.logic";

const EMPTY_TURN_DIFFS: Map<MessageId, TurnDiffSummary> = new Map();
const EMPTY_REVERT_COUNTS: Map<MessageId, number> = new Map();
const NOOP = () => {};

/** MessagesTimeline with every chat-only affordance stubbed to a no-op. */
function ReadOnlyTimeline({
  environmentId,
  routeThreadKey,
  timelineEntries,
  latestTurn,
  runningTurnId,
  isWorking,
  activeTurnStartedAt,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly timelineEntries: TimelineEntry[];
  readonly latestTurn: TimelineLatestTurn | null;
  readonly runningTurnId: TurnId | null;
  readonly isWorking: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly workspaceRoot: string | undefined;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  return (
    <MessagesTimeline
      isWorking={isWorking}
      activeTurnStartedAt={activeTurnStartedAt}
      listRef={listRef}
      timelineEntries={timelineEntries}
      latestTurn={latestTurn}
      runningTurnId={runningTurnId}
      turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
      routeThreadKey={routeThreadKey}
      onOpenTurnDiff={NOOP}
      revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
      onRevertUserMessage={NOOP}
      isRevertingCheckpoint={false}
      onImageExpand={NOOP}
      activeThreadEnvironmentId={environmentId}
      markdownCwd={workspaceRoot}
      resolvedTheme={resolvedTheme}
      timestampFormat={settings.timestampFormat}
      workspaceRoot={workspaceRoot}
      anchorMessageId={null}
      onAnchorReady={NOOP}
      contentInsetEndAdjustment={0}
      liveFollowEnabled
      onIsAtEndChange={NOOP}
      onManualNavigation={NOOP}
    />
  );
}

/** Live timeline over any thread ref, visuals identical to the main chat. */
export const ThreadTimelineView = memo(function ThreadTimelineView({
  environmentId,
  threadId,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | undefined;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const detail = useThreadDetail(threadRef);
  const shell = useThreadShell(threadRef);
  const activities = detail?.activities;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(activities ?? []), [activities]);
  const turnPlans = useMemo(() => deriveTurnPlans(activities ?? []), [activities]);
  const messages = detail?.messages;
  const proposedPlans = detail?.proposedPlans;
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(messages ?? [], proposedPlans ?? [], workLogEntries, turnPlans),
    [messages, proposedPlans, workLogEntries, turnPlans],
  );
  const latestTurn = shell?.latestTurn ?? null;
  const runningTurnId =
    detail?.session?.status === "running" ? (detail.session.activeTurnId ?? null) : null;
  const isWorking = runningTurnId !== null || latestTurn?.state === "running";
  return (
    <ReadOnlyTimeline
      environmentId={environmentId}
      routeThreadKey={`${environmentId}:${threadId}`}
      timelineEntries={timelineEntries}
      latestTurn={latestTurn}
      runningTurnId={runningTurnId}
      isWorking={isWorking}
      activeTurnStartedAt={isWorking ? (latestTurn?.startedAt ?? null) : null}
      workspaceRoot={workspaceRoot}
    />
  );
});

/** A subagent run's transcript, rendered with the chat timeline's visuals. */
export const SubagentTimelineView = memo(function SubagentTimelineView({
  environmentId,
  transcriptKey,
  blocks,
}: {
  readonly environmentId: EnvironmentId;
  /** Stable identity of the shown run, so switching runs resets list state. */
  readonly transcriptKey: string;
  readonly blocks: ReadonlyArray<SubagentTranscriptBlock>;
}) {
  const timelineEntries = useMemo(() => deriveSubagentTimelineEntries(blocks), [blocks]);
  return (
    <ReadOnlyTimeline
      environmentId={environmentId}
      routeThreadKey={transcriptKey}
      timelineEntries={timelineEntries}
      latestTurn={null}
      runningTurnId={null}
      isWorking={false}
      activeTurnStartedAt={null}
      workspaceRoot={undefined}
    />
  );
});
