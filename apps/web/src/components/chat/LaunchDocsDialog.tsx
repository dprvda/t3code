import type { EnvironmentId, ProjectDocMapEntry } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

/** ~4 chars per token; the estimate is labeled approximate everywhere. */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
  return `~${tokens}`;
}

type TreeNode = {
  readonly rel: string;
  readonly name: string;
  readonly kind: "dir" | "doc";
  readonly tokens: number;
  readonly depth: number;
  readonly children: TreeNode[];
};

function buildTree(entries: readonly ProjectDocMapEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const segments = entry.rel.split("/");
    const node: TreeNode = {
      rel: entry.rel,
      name: segments.at(-1) ?? entry.rel,
      kind: entry.kind,
      tokens: entry.tokens,
      depth: segments.length - 1,
      children: [],
    };
    nodes.set(entry.rel, node);
    const parent = segments.length > 1 ? nodes.get(segments.slice(0, -1).join("/")) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const order = (list: TreeNode[]): void => {
    list.sort((a, b) => (a.kind === b.kind ? (a.rel < b.rel ? -1 : 1) : a.kind === "dir" ? -1 : 1));
    for (const node of list) order(node.children);
  };
  order(roots);
  return roots;
}

function ancestorDirs(rel: string): string[] {
  const segments = rel.split("/").slice(0, -1);
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

export interface LaunchDocsDialogProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The repo's doc map as a selectable tree. The selection is saved to
 * `.t3/launch-docs.json` in the workspace and injected as a read-first
 * block into the first message of every new session in this project.
 * Selecting a folder covers everything beneath it — including docs added
 * to it later.
 */
export function LaunchDocsDialog(props: LaunchDocsDialogProps) {
  const [entries, setEntries] = useState<readonly ProjectDocMapEntry[] | null>(null);
  const [include, setInclude] = useState<readonly string[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const fetchDocMap = useAtomQueryRunner(projectEnvironment.docMap, { reportFailure: false });
  const fetchLaunchDocs = useAtomQueryRunner(projectEnvironment.launchDocs, {
    reportFailure: false,
  });
  const saveLaunchDocs = useAtomCommand(projectEnvironment.launchDocsSet);

  useEffect(() => {
    if (!props.open) return;
    setEntries(null);
    setLoadFailed(false);
    void (async () => {
      const [mapResult, configResult] = await Promise.all([
        fetchDocMap({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
        fetchLaunchDocs({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
      ]);
      if (mapResult._tag !== "Success" || configResult._tag !== "Success") {
        setLoadFailed(true);
        return;
      }
      setEntries(mapResult.value.entries);
      setInclude(configResult.value.include);
      // Deep repos start with only the top level open; shallow ones fully open.
      const dirs = mapResult.value.entries.filter((entry) => entry.kind === "dir");
      setCollapsed(
        new Set(
          dirs.length > 30
            ? dirs.filter((entry) => entry.rel.includes("/")).map((entry) => entry.rel)
            : [],
        ),
      );
    })();
  }, [props.open, props.environmentId, props.cwd, fetchDocMap, fetchLaunchDocs]);

  const tree = useMemo(() => (entries === null ? [] : buildTree(entries)), [entries]);
  const includeSet = useMemo(() => new Set(include), [include]);
  const coveredByAncestor = useCallback(
    (rel: string) => ancestorDirs(rel).some((dir) => includeSet.has(`${dir}/`)),
    [includeSet],
  );
  const selectedDocs = useMemo(
    () =>
      (entries ?? []).filter(
        (entry) =>
          entry.kind === "doc" && (includeSet.has(entry.rel) || coveredByAncestor(entry.rel)),
      ),
    [entries, includeSet, coveredByAncestor],
  );
  const selectedTokens = selectedDocs.reduce((sum, entry) => sum + entry.tokens, 0);

  const toggle = useCallback((node: TreeNode) => {
    const key = node.kind === "dir" ? `${node.rel}/` : node.rel;
    setInclude((previous) =>
      previous.includes(key)
        ? previous.filter((entry) => entry !== key)
        : [
            // Selecting a folder subsumes any selection beneath it.
            ...previous.filter((entry) => node.kind !== "dir" || !entry.startsWith(`${node.rel}/`)),
            key,
          ],
    );
  }, []);

  const save = useCallback(() => {
    setIsSaving(true);
    void (async () => {
      const result = await saveLaunchDocs({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, include },
      });
      setIsSaving(false);
      if (result._tag === "Success") props.onOpenChange(false);
    })();
  }, [saveLaunchDocs, props, include]);

  const renderNode = (node: TreeNode): React.ReactNode => {
    const covered = coveredByAncestor(node.rel);
    const checked = covered || includeSet.has(node.kind === "dir" ? `${node.rel}/` : node.rel);
    const isCollapsed = collapsed.has(node.rel);
    return (
      <div key={node.rel}>
        <div
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent"
          style={{ paddingLeft: `${node.depth * 16 + 6}px` }}
        >
          {node.kind === "dir" ? (
            <button
              type="button"
              aria-label={isCollapsed ? `Expand ${node.rel}` : `Collapse ${node.rel}`}
              className="text-secondary-label hover:text-foreground"
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(node.rel)) next.delete(node.rel);
                  else next.add(node.rel);
                  return next;
                })
              }
            >
              {isCollapsed ? (
                <ChevronRightIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="w-3.5" />
          )}
          <Checkbox
            checked={checked}
            disabled={covered}
            aria-label={`Inject ${node.rel}`}
            onCheckedChange={() => toggle(node)}
          />
          {node.kind === "dir" ? (
            <FolderIcon className="size-3.5 shrink-0 text-secondary-label" />
          ) : (
            <FileTextIcon className="size-3.5 shrink-0 text-secondary-label" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs">
            {node.name}
            {node.kind === "dir" ? "/" : ""}
          </span>
          <span className="shrink-0 text-[10px] text-secondary-label tabular-nums">
            {formatTokens(node.tokens)} tok
          </span>
        </div>
        {node.kind === "dir" && !isCollapsed ? node.children.map(renderNode) : null}
      </div>
    );
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Session-start docs</DialogTitle>
          <DialogDescription>
            Injected as a read-first block into the first message of every new session in this
            project. Selecting a folder includes every doc beneath it, current and future. Saved to{" "}
            <code className="text-[11px]">.t3/launch-docs.json</code> in the workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-1">
          {loadFailed ? (
            <div className="px-2 py-3 text-secondary-label text-xs">
              Failed to scan the workspace doc map.
            </div>
          ) : entries === null ? (
            <div className="px-2 py-3 text-secondary-label text-xs">Scanning workspace…</div>
          ) : tree.length === 0 ? (
            <div className="px-2 py-3 text-secondary-label text-xs">
              No markdown docs in this workspace.
            </div>
          ) : (
            tree.map(renderNode)
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-secondary-label text-xs">
            {selectedDocs.length} docs · {formatTokens(selectedTokens)} tok (approx.) at session
            start
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={entries === null || isSaving} onClick={save}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
