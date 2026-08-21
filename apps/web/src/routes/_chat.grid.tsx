import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HandIcon, RecycleIcon } from "lucide-react";
import { useMemo } from "react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useProjects, useThreadDetail, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "~/lib/utils";

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

function lastAssistantLine(detail: EnvironmentThread | null): string | null {
  if (detail === null) return null;
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.messages[index];
    if (message?.role !== "assistant") continue;
    const line = message.text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line !== undefined) return line;
  }
  return null;
}

function contextBarClass(pct: number): string {
  if (pct >= 75) return "bg-red-500/80";
  if (pct >= 50) return "bg-amber-500/80";
  return "bg-sky-500/70";
}

function ThreadCell({
  shell,
  projectTitle,
}: {
  readonly shell: EnvironmentThreadShell;
  readonly projectTitle: string;
}) {
  const detail = useThreadDetail(scopeThreadRef(shell.environmentId, shell.id));
  const requestRecycle = useAtomCommand(threadEnvironment.requestRecycle, "thread recycle request");
  const pill = resolveThreadStatusPill({ thread: shell }) ?? fallbackStatusPill(shell);
  const word = statusWord(shell, pill);
  const pct = contextUsagePct(detail);
  const lastLine = lastAssistantLine(detail);
  const needsYou =
    shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan;

  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: shell.environmentId, threadId: shell.id }}
      data-thread-grid-cell={shell.id}
      className="flex min-h-32 flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-ring/40 hover:bg-accent/40"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            pill.dotClass,
            pill.pulse && "animate-pulse",
          )}
        />
        <span className={cn("shrink-0 font-medium text-xs", pill.colorClass)}>{word}</span>
        {needsYou ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-300/90">
            <HandIcon className="size-3" /> needs you
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Recycle session"
                className={cn(
                  "shrink-0 rounded-md p-1 text-secondary-label hover:bg-accent hover:text-foreground",
                  needsYou ? "" : "ml-auto",
                )}
                onClick={(clickEvent) => {
                  clickEvent.preventDefault();
                  clickEvent.stopPropagation();
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
      <div className="min-w-0">
        <div className="truncate font-medium text-sm" title={shell.title}>
          {shell.title}
        </div>
        <div className="truncate text-[11px] text-secondary-label">
          {projectTitle} · {shell.modelSelection.model}
        </div>
      </div>
      <div className="line-clamp-2 min-h-8 text-secondary-label text-xs">
        {lastLine ?? (detail === null ? "…" : "No assistant output yet.")}
      </div>
      <div className="mt-auto flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          {pct !== null ? (
            <div className={cn("h-full", contextBarClass(pct))} style={{ width: `${pct}%` }} />
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-secondary-label tabular-nums">
          {pct !== null ? `ctx ${Math.round(pct)}%` : "ctx —"}
        </span>
      </div>
    </Link>
  );
}

function ThreadGridRouteView() {
  const shells = useThreadShells();
  const projects = useProjects();
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const cells = useMemo(
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
          <span className="text-secondary-label text-xs">every thread, live</span>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {cells.length === 0 ? (
            <div className="p-8 text-center text-secondary-label text-sm">No threads yet.</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
              {cells.map((shell) => (
                <ThreadCell
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
