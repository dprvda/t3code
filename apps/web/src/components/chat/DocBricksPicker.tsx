import type { EnvironmentId, ProjectDocBrick } from "@t3tools/contracts";
import { BookOpenIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

/** ~4 chars per token; the estimate is labeled approximate everywhere. */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
  return `~${tokens}`;
}

export interface DocBricksPickerProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}

/**
 * Composer pill for the workspace's read-first doc candidates ("bricks"):
 * identity docs, spine docs, and the newest handoff. Selected bricks are
 * prepended to the outgoing message as a read-these-first block.
 */
export function DocBricksPicker(props: DocBricksPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [bricks, setBricks] = useState<readonly ProjectDocBrick[] | null>(null);
  const fetchDocBricks = useAtomQueryRunner(projectEnvironment.docBricks, {
    reportFailure: false,
  });

  const refresh = useCallback(() => {
    void (async () => {
      const result = await fetchDocBricks({
        environmentId: props.environmentId,
        input: { cwd: props.cwd },
      });
      if (result._tag === "Success") {
        setBricks(result.value.bricks);
      }
    })();
  }, [fetchDocBricks, props.environmentId, props.cwd]);

  const selectedTokens = (bricks ?? [])
    .filter((brick) => props.selected.includes(brick.rel))
    .reduce((sum, brick) => sum + brick.tokens, 0);
  const triggerLabel =
    props.selected.length === 0
      ? "docs"
      : `docs ${props.selected.length} · ${formatTokens(selectedTokens)}`;

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) refresh();
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label="Read-first docs"
            data-chat-doc-bricks-picker="true"
            className="whitespace-nowrap"
          />
        }
      >
        <ComposerControlIcon icon={BookOpenIcon} />
        <span className="hidden sm:inline">{triggerLabel}</span>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 p-2">
        <div className="px-1.5 pb-1.5 font-medium text-secondary-label text-xs">
          Read-first docs
        </div>
        {bricks === null ? (
          <div className="px-1.5 py-2 text-secondary-label text-xs">Scanning workspace…</div>
        ) : bricks.length === 0 ? (
          <div className="px-1.5 py-2 text-secondary-label text-xs">
            No doc candidates in this workspace.
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {bricks.map((brick) => {
              const checked = props.selected.includes(brick.rel);
              return (
                <label
                  key={brick.rel}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent"
                >
                  <Checkbox
                    checked={checked}
                    disabled={!brick.exists}
                    onCheckedChange={() => {
                      props.onChange(
                        checked
                          ? props.selected.filter((rel) => rel !== brick.rel)
                          : [...props.selected, brick.rel],
                      );
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs" title={brick.rel}>
                    {brick.rel}
                  </span>
                  <span className="shrink-0 text-[10px] text-secondary-label tabular-nums">
                    {brick.exists ? `${formatTokens(brick.tokens)} tok` : "missing"}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {props.selected.length > 0 ? (
          <div className="mt-1 flex items-center justify-between border-border border-t px-1.5 pt-1.5 text-[10px] text-secondary-label">
            <span>
              {props.selected.length} selected · {formatTokens(selectedTokens)} tok (approx.)
            </span>
            <button
              type="button"
              className="text-secondary-label underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => props.onChange([])}
            >
              clear
            </button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
