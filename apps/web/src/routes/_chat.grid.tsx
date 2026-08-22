import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleCheckIcon, HandIcon, RecycleIcon, UndoDotIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ThreadTimelineView } from "../components/chat/ThreadTimelineView";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useProjects, useThreadDetail, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { cn, newMessageId } from "~/lib/utils";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * ADE's grid law (owner 2026-07-17), ported verbatim: HEIGHT-FIRST — pick the
 * FEWEST rows whose column count still leaves cells >= the hard width floor,
 * so taller panes beat wider ones; near-equal row sizes get balanced spans on
 * an LCM track grid, and rows stretch to exactly fill the viewport.
 */
function gridLayout(
  n: number,
  panesW: number,
  panesH: number,
): { style: CSSProperties | undefined; spans: number[] } {
  if (n === 0 || panesW === 0) return { style: undefined, spans: [] };
  const MIN_W = 420;
  const MIN_H = 300;
  let rows = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(panesW / MIN_W))));
  for (let r = 1; r <= n; r++) {
    if (panesW / Math.ceil(n / r) >= MIN_W) {
      rows = r;
      break;
    }
  }
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const rowCounts = Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
  const tracks = rowCounts.reduce((acc, c) => (acc * c) / gcd(acc, c), 1);
  const spans: number[] = [];
  for (const count of rowCounts) for (let i = 0; i < count; i++) spans.push(tracks / count);
  const fitH = Math.max(MIN_H, Math.floor(panesH / rows) - 1);
  return {
    style: {
      gridTemplateColumns: `repeat(${tracks}, 1fr)`,
      gridAutoRows: `minmax(${Math.min(fitH, Math.floor(panesH / rows))}px, 1fr)`,
    },
    spans,
  };
}

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

function SessionPane({
  shell,
  projectTitle,
  style,
}: {
  readonly shell: EnvironmentThreadShell;
  readonly projectTitle: string;
  readonly style?: CSSProperties;
}) {
  const detail = useThreadDetail(scopeThreadRef(shell.environmentId, shell.id));
  const requestRecycle = useAtomCommand(threadEnvironment.requestRecycle, "thread recycle request");
  const settleThread = useAtomCommand(threadEnvironment.settle, "thread settle");
  const unsettleThread = useAtomCommand(threadEnvironment.unsettle, "thread unsettle");
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "thread turn start");
  const pill = resolveThreadStatusPill({ thread: shell }) ?? fallbackStatusPill(shell);
  const word = statusWord(shell, pill);
  const pct = contextUsagePct(detail);
  const needsYou =
    shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan;
  const isSettled = shell.settledAt !== null || shell.settledOverride === "settled";
  const [draft, setDraft] = useState("");

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
      style={style}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
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
                aria-label={isSettled ? "Unsettle thread" : "Settle thread"}
                className="shrink-0 rounded-md p-1 text-secondary-label hover:bg-accent hover:text-foreground"
                onClick={() => {
                  if (isSettled) {
                    void unsettleThread({
                      environmentId: shell.environmentId,
                      input: { threadId: shell.id, reason: "user" },
                    });
                  } else {
                    void settleThread({
                      environmentId: shell.environmentId,
                      input: { threadId: shell.id },
                    });
                  }
                }}
              />
            }
          >
            {isSettled ? (
              <UndoDotIcon className="size-3.5" />
            ) : (
              <CircleCheckIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">{isSettled ? "Unsettle" : "Settle"}</TooltipPopup>
        </Tooltip>
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
      {/* live session timeline — the main chat's exact rendering */}
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
        <ThreadTimelineView environmentId={shell.environmentId} threadId={shell.id} />
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
  // STABLE order (owner: panes must not jump while sessions stream).
  // createdAt never changes, so a pane keeps its position for its lifetime;
  // sorting by updatedAt reshuffled the wall on every activity tick.
  const panes = useMemo(
    () =>
      shells
        .filter((shell) => shell.archivedAt === null)
        .sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1,
        ),
    [shells],
  );

  const panesRef = useRef<HTMLDivElement>(null);
  const [panesSize, setPanesSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const element = panesRef.current;
    if (element === null) return;
    const measure = () =>
      setPanesSize({ w: element.clientWidth - 16, h: element.clientHeight - 16 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => gridLayout(panes.length, panesSize.w, panesSize.h),
    [panes.length, panesSize.w, panesSize.h],
  );

  return (
    <SidebarInset>
      <div className="flex h-full min-h-0 flex-col">
        <WorkspacePageHeader>
          <span className="font-medium text-sm">Grid</span>
          <span className="text-secondary-label text-xs">every session, live</span>
        </WorkspacePageHeader>
        <div ref={panesRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {panes.length === 0 ? (
            <div className="p-8 text-center text-secondary-label text-sm">No threads yet.</div>
          ) : (
            <div className="grid h-full gap-2" style={layout.style}>
              {panes.map((shell, index) => (
                <SessionPane
                  key={`${shell.environmentId}:${shell.id}`}
                  shell={shell}
                  projectTitle={projectTitles.get(shell.projectId) ?? "Unknown project"}
                  style={{ gridColumn: `span ${layout.spans[index] ?? 1}` }}
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
