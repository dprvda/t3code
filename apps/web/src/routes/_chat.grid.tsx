import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HandIcon, RecycleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useProjects, useThreadDetail, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { cn, newMessageId } from "~/lib/utils";

/** Fallback pill for settled/idle states the sidebar resolver leaves null. */
function fallbackStatusPill(shell: EnvironmentThreadShell): ThreadStatusPill {
  if (shell.latestTurn?.state === "error") {
    return {
      label: "Completed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }
  return {
    label: "Completed",
    colorClass: "text-secondary-label",
    dotClass: "bg-muted-foreground/50",
    pulse: false,
  };
}

function statusWord(shell: EnvironmentThreadShell, pill: ThreadStatusPill): string {
  if (pill.colorClass === "text-secondary-label") {
    return shell.settledAt !== null || shell.settledOverride === "settled" ? "Settled" : "Idle";
  }
  if (shell.latestTurn?.state === "error" && pill.label === "Completed") {
    return "Failed";
  }
  return pill.label;
}

/** Latest context usage from the thread's activity stream, as a 0-100 pct. */
function contextUsagePct(detail: EnvironmentThread | null): number | null {
  if (detail === null) return null;
  for (let index = detail.activities.length - 1; index >= 0; index -= 1) {
    const activity = detail.activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const payload = activity.payload as { usedTokens?: number; maxTokens?: number };
    if (
      typeof payload?.usedTokens === "number" &&
      typeof payload.maxTokens === "number" &&
      payload.maxTokens > 0
    ) {
      return Math.min(100, (payload.usedTokens / payload.maxTokens) * 100);
    }
  }
  return null;
}

type FeedBlock = {
  readonly key: string;
  readonly kind: "user" | "assistant" | "tool";
  readonly text: string;
  readonly at: string;
};

/**
 * The pane feed: every user and assistant message (streaming included)
 * interleaved with tool calls, oldest first — the session's whole life, the
 * way ADE's terminal wall showed it.
 */
function buildFeed(detail: EnvironmentThread | null): FeedBlock[] {
  if (detail === null) return [];
  const blocks: FeedBlock[] = [];
  for (const message of detail.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.text.trim().length === 0) continue;
    blocks.push({
      key: `m:${message.id}`,
      kind: message.role,
      text: message.text,
      at: message.createdAt,
    });
  }
  // one line per tool call, latest state wins
  const toolBlocks = new Map<string, FeedBlock>();
  for (const activity of detail.activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = activity.payload as { toolCallId?: unknown; detail?: unknown } | null;
    const callKey =
      typeof payload?.toolCallId === "string" ? payload.toolCallId : String(activity.id);
    const text = typeof payload?.detail === "string" ? payload.detail : activity.summary;
    const existing = toolBlocks.get(callKey);
    toolBlocks.set(callKey, {
      key: `t:${callKey}`,
      kind: "tool",
      text: `▸ ${text.split("\n")[0] ?? ""}`,
      // keep the first-seen timestamp so the call stays in stream order
      at: existing?.at ?? activity.createdAt,
    });
  }
  blocks.push(...toolBlocks.values());
  blocks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return blocks.slice(-120);
}

function SessionPane({
  shell,
  projectTitle,
}: {
  readonly shell: EnvironmentThreadShell;
  readonly projectTitle: string;
}) {
  const detail = useThreadDetail(scopeThreadRef(shell.environmentId, shell.id));
  const requestRecycle = useAtomCommand(threadEnvironment.requestRecycle, "thread recycle request");
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "thread turn start");
  const pill = resolveThreadStatusPill({ thread: shell }) ?? fallbackStatusPill(shell);
  const word = statusWord(shell, pill);
  const pct = contextUsagePct(detail);
  const needsYou =
    shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan;
  const feed = useMemo(() => buildFeed(detail), [detail]);
  const [draft, setDraft] = useState("");

  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const feedSize = feed.reduce((sum, block) => sum + block.text.length, 0);
  useEffect(() => {
    const body = bodyRef.current;
    if (body !== null && stickRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [feedSize]);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    void startTurn({
      environmentId: shell.environmentId,
      input: {
        threadId: shell.id,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      },
    });
  };

  return (
    <div
      data-thread-grid-cell={shell.id}
      className="flex h-96 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      {/* titlebar */}
      <div className="flex shrink-0 items-center gap-2 border-border border-b px-2.5 py-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            pill.dotClass,
            pill.pulse && "animate-pulse",
          )}
        />
        <span className={cn("shrink-0 font-medium text-[11px]", pill.colorClass)}>{word}</span>
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: shell.environmentId, threadId: shell.id }}
          className="min-w-0 flex-1 truncate text-xs hover:underline"
          title={`${projectTitle} · ${shell.title}`}
        >
          {shell.title}
        </Link>
        {needsYou ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-300/90">
            <HandIcon className="size-3" /> needs you
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-secondary-label tabular-nums">
          {pct !== null ? `ctx ${Math.round(pct)}%` : "ctx —"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Recycle session"
                className="shrink-0 rounded-md p-1 text-secondary-label hover:bg-accent hover:text-foreground"
                onClick={() => {
                  void requestRecycle({
                    environmentId: shell.environmentId,
                    input: { threadId: shell.id },
                  });
                }}
              />
            }
          >
            <RecycleIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Recycle: handoff, then a fresh session</TooltipPopup>
        </Tooltip>
      </div>
      {/* live session feed */}
      <div
        ref={bodyRef}
        onScroll={() => {
          const body = bodyRef.current;
          if (body === null) return;
          stickRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-4"
      >
        {feed.length === 0 ? (
          <div className="text-secondary-label">{detail === null ? "…" : "No output yet."}</div>
        ) : (
          feed.map((block) => (
            <div
              key={block.key}
              className={cn(
                "whitespace-pre-wrap break-words",
                block.kind === "user" && "text-sky-700 dark:text-sky-300/90",
                block.kind === "assistant" && "text-foreground/90",
                block.kind === "tool" && "text-secondary-label",
              )}
            >
              {block.kind === "user" ? `❯ ${block.text}` : block.text}
            </div>
          ))
        )}
      </div>
      {/* per-pane composer */}
      <div className="flex shrink-0 items-center gap-1.5 border-border border-t px-2.5 py-1.5">
        <span aria-hidden="true" className="font-mono text-[11px] text-secondary-label">
          ❯
        </span>
        <input
          value={draft}
          onChange={(changeEvent) => setDraft(changeEvent.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
              keyEvent.preventDefault();
              send();
            }
          }}
          placeholder={`message ${shell.modelSelection.model}…`}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-secondary-label/60"
        />
      </div>
    </div>
  );
}

function ThreadGridRouteView() {
  const shells = useThreadShells();
  const projects = useProjects();
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const panes = useMemo(
    () =>
      shells
        .filter((shell) => shell.archivedAt === null)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [shells],
  );

  return (
    <SidebarInset>
      <div className="flex h-full min-h-0 flex-col">
        <WorkspacePageHeader>
          <span className="font-medium text-sm">Grid</span>
          <span className="text-secondary-label text-xs">every session, live</span>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {panes.length === 0 ? (
            <div className="p-8 text-center text-secondary-label text-sm">No threads yet.</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(23rem,1fr))] gap-3">
              {panes.map((shell) => (
                <SessionPane
                  key={`${shell.environmentId}:${shell.id}`}
                  shell={shell}
                  projectTitle={projectTitles.get(shell.projectId) ?? "Unknown project"}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/grid")({
  component: ThreadGridRouteView,
});
