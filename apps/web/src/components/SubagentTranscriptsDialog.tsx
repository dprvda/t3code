import type {
  EnvironmentId,
  SubagentRunSummary,
  SubagentTranscriptBlock,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { PaneComposer } from "./chat/PaneComposer";
import { SubagentTimelineView } from "./chat/ThreadTimelineView";
import { subagentViewEnvironment } from "../state/subagentView";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "?";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Full-output viewer over the on-disk subagent runs of a thread: pick a run,
 * read its whole conversation (prompt, tool calls, results, final answer).
 */
export function SubagentTranscriptsDialog({
  environmentId,
  threadId,
  open,
  onOpenChange,
  preselectAgentId = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly preselectAgentId?: string | null;
}) {
  const fetchRuns = useAtomQueryRunner(subagentViewEnvironment.runs, { reportFailure: false });
  const fetchTranscript = useAtomQueryRunner(subagentViewEnvironment.transcript, {
    reportFailure: false,
  });
  const [runs, setRuns] = useState<readonly SubagentRunSummary[] | null>(null);
  const [selected, setSelected] = useState<SubagentRunSummary | null>(null);
  const [blocks, setBlocks] = useState<readonly SubagentTranscriptBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openRunRef = useRef<((run: SubagentRunSummary) => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void (async () => {
      const result = await fetchRuns({ environmentId, input: { threadId } });
      if (result._tag === "Success") {
        setRuns(result.value.runs);
        if (result.value.runs.length === 0) setError("No subagent runs recorded for this thread.");
      } else {
        setRuns([]);
        setError("Subagent runs unavailable for this thread.");
      }
    })();
  }, [open, environmentId, threadId, fetchRuns]);

  // On open, populate the right pane: the preselected run if it matches,
  // otherwise the newest run — so the transcript and steer box are never empty
  // when there is anything to show.
  useEffect(() => {
    if (!open || runs === null || runs.length === 0 || selected !== null) return;
    const match =
      (preselectAgentId !== null ? runs.find((run) => run.id === preselectAgentId) : undefined) ??
      runs[0];
    if (match !== undefined) openRunRef.current?.(match);
  }, [open, runs, preselectAgentId, selected]);

  // Reset selection each time the dialog is reopened so preselect can re-run.
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setBlocks(null);
    }
  }, [open]);

  const openRun = useCallback(
    (run: SubagentRunSummary) => {
      setSelected(run);
      setBlocks(null);
      void (async () => {
        const result = await fetchTranscript({
          environmentId,
          input: { threadId, parentSessionId: run.parentSessionId, agentFileId: run.id },
        });
        setBlocks(result._tag === "Success" ? result.value.blocks : []);
      })();
    },
    [environmentId, threadId, fetchTranscript],
  );
  openRunRef.current = openRun;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>Subagent transcripts</DialogTitle>
          <DialogDescription>
            Every Agent-tool run this thread's sessions recorded, with full output.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-3">
          <ScrollArea className="w-64 shrink-0 rounded-md border border-border">
            <div className="flex flex-col gap-0.5 p-1.5">
              {runs === null ? (
                <div className="p-2 text-secondary-label text-xs">Loading…</div>
              ) : runs.length === 0 ? (
                <div className="p-2 text-secondary-label text-xs">{error ?? "No runs."}</div>
              ) : (
                runs.map((run) => (
                  <button
                    key={`${run.parentSessionId}:${run.id}`}
                    type="button"
                    onClick={() => openRun(run)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-left hover:bg-accent",
                      selected?.id === run.id && "bg-accent",
                    )}
                  >
                    <div className="truncate font-medium text-xs" title={run.description}>
                      {run.description}
                    </div>
                    <div className="truncate text-[10px] text-secondary-label">
                      {run.agentType}
                      {run.model !== null ? ` · ${run.model}` : ""} · {formatWhen(run.modifiedAt)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
          {/* Transcript pane: the main chat's exact timeline rendering; the
              timeline owns its scrolling, so no ScrollArea wrapper here. */}
          <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
            {selected === null ? (
              <div className="p-3 text-secondary-label text-xs">Pick a run on the left.</div>
            ) : blocks === null ? (
              <div className="p-3 text-secondary-label text-xs">Loading transcript…</div>
            ) : blocks.length === 0 ? (
              <div className="p-3 text-secondary-label text-xs">
                Transcript is empty or unavailable.
              </div>
            ) : (
              <SubagentTimelineView
                environmentId={environmentId}
                transcriptKey={`${selected.parentSessionId}:${selected.id}`}
                blocks={blocks}
              />
            )}
          </div>
        </div>
        {selected !== null ? (
          <PaneComposer
            environmentId={environmentId}
            threadId={threadId}
            placeholder="message this session (steers the running agent, like typing during a Task)…"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
