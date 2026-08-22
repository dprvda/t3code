/**
 * Compact router-account rows for the sidebar footer: provider badge, masked
 * email, 5h + weekly quota percentages, refreshed every 60 s like the Router
 * Pool settings panel (the visual reference — this is its subtle sibling).
 * Renders nothing while loading or when the router is unreachable, so the
 * footer stays clean on machines without a pool.
 */
import type { RouterAccountRow } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import { routerPoolEnvironment } from "../../state/routerPool";
import { useAtomCommand } from "../../state/use-atom-command";
import { maskEmail } from "../settings/RouterPoolPanel";

function pctTone(pct: number): string {
  if (pct >= 90) return "text-red-600 dark:text-red-300/90";
  if (pct >= 75) return "text-amber-600 dark:text-amber-300/90";
  return "text-secondary-label";
}

function WindowPct({
  label,
  row,
}: {
  readonly label: "5h" | "week";
  readonly row: RouterAccountRow;
}) {
  const window = row.windows.find((entry) => entry.label === label);
  const short = label === "week" ? "wk" : label;
  if (window === undefined) {
    return <span className="text-secondary-label/60 tabular-nums">{short} —</span>;
  }
  return (
    <span className={cn("tabular-nums", pctTone(window.pct))} title={window.resetsAt ?? undefined}>
      {short} {Math.round(window.pct)}%
    </span>
  );
}

export const SidebarRouterAccounts = memo(function SidebarRouterAccounts() {
  const environmentId = useActiveEnvironmentId();
  const navigate = useNavigate();
  const fetchAccounts = useAtomCommand(routerPoolEnvironment.accountsFetch, {
    reportFailure: false,
    reportDefect: false,
  });
  const [rows, setRows] = useState<readonly RouterAccountRow[] | null>(null);

  const refresh = useCallback(() => {
    if (environmentId === null) return;
    void (async () => {
      const result = await fetchAccounts({ environmentId, input: { force: false } });
      if (result._tag === "Success") setRows(result.value.rows);
    })();
  }, [environmentId, fetchAccounts]);

  useEffect(() => {
    // Commands fail fast while the environment ws is still connecting —
    // retry quickly until the first load lands, then poll slowly.
    let cancelled = false;
    let attempts = 0;
    const prime = () => {
      if (cancelled) return;
      void (async () => {
        if (environmentId === null) return;
        const result = await fetchAccounts({ environmentId, input: { force: false } });
        if (cancelled) return;
        if (result._tag === "Success") {
          setRows(result.value.rows);
          return;
        }
        if (attempts++ < 20) setTimeout(prime, 3_000);
      })();
    };
    prime();
    const id = setInterval(() => refresh(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, fetchAccounts, environmentId]);

  if (rows === null || rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-px pb-0.5">
      {rows.map((row) => {
        const trouble = row.enabled && (row.stale || row.error !== null);
        return (
          <button
            key={row.file}
            type="button"
            onClick={() => void navigate({ to: "/settings/router-pool" })}
            title={`${row.email} (${row.provider})${row.error !== null ? ` · ${row.error}` : row.stale ? " · stale" : ""} — open Router Pool`}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[10px] leading-4 hover:bg-accent",
              !row.enabled && "opacity-45",
            )}
          >
            <span
              className={cn(
                "shrink-0 rounded px-1 font-medium text-[9px] uppercase",
                row.provider === "claude"
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-300/90"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300/90",
              )}
            >
              {row.provider}
            </span>
            {trouble ? (
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-red-500" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-secondary-label">
              {maskEmail(row.email)}
            </span>
            <WindowPct label="5h" row={row} />
            <WindowPct label="week" row={row} />
          </button>
        );
      })}
    </div>
  );
});
