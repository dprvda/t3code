import type {
  EnvironmentId,
  RouterAccountRow,
  RouterLoginProvider,
  RouterLoginStatus,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import { routerPoolEnvironment } from "../../state/routerPool";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

// "pattiterrainmiser@gmail.com" -> "p**r"; full email lives in the title attr
function maskEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local.length < 2 ? local : `${local[0]}**${local[local.length - 1]}`;
}

function fmtReset(resetsAt: string | null): string {
  if (resetsAt === null) return "?";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "?";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtCountdown(resetsAt: string | null, nowMs: number): string {
  if (resetsAt === null) return "?";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "?";
  const ms = at - nowMs;
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function barTone(pct: number): string {
  if (pct >= 90) return "bg-red-500/80";
  if (pct >= 75) return "bg-amber-500/80";
  return "bg-sky-500/70";
}

function QuotaRow({
  label,
  row,
  nowMs,
}: {
  readonly label: "5h" | "week";
  readonly row: RouterAccountRow;
  readonly nowMs: number;
}) {
  const window = row.windows.find((entry) => entry.label === label);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-9 shrink-0 uppercase text-[10px] text-secondary-label">{label}</span>
      {window === undefined ? (
        <span className="text-secondary-label">n/a</span>
      ) : (
        <>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full", barTone(window.pct))}
              style={{ width: `${window.pct}%` }}
            />
          </div>
          <span className="tabular-nums" title={window.resetsAt ?? undefined}>
            {/* Anthropic reports weekly 100% while the credential still works */}
            {row.provider === "claude" && window.pct >= 100 ? "100% reported" : `${window.pct}%`}
          </span>
          <span className="text-secondary-label">
            {fmtReset(window.resetsAt)} · {fmtCountdown(window.resetsAt, nowMs)}
          </span>
        </>
      )}
    </div>
  );
}

function LoginFlow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const startLogin = useAtomCommand(routerPoolEnvironment.loginStart, "router login start");
  const pollStatus = useAtomQueryRunner(routerPoolEnvironment.loginStatus, {
    reportFailure: false,
  });
  const [status, setStatus] = useState<RouterLoginStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const begin = useCallback(
    (provider: RouterLoginProvider) => {
      void (async () => {
        const result = await startLogin({ environmentId, input: { provider } });
        if (result._tag !== "Success") return;
        setStatus(result.value);
        if (pollRef.current !== null) clearInterval(pollRef.current);
        pollRef.current = setInterval(() => {
          void (async () => {
            const polled = await pollStatus({
              environmentId,
              input: { loginId: result.value.loginId },
            });
            if (polled._tag !== "Success") return;
            setStatus(polled.value);
            if (polled.value.state === "done" || polled.value.state === "failed") {
              if (pollRef.current !== null) clearInterval(pollRef.current);
              pollRef.current = null;
            }
          })();
        }, 1500);
      })();
    },
    [environmentId, pollStatus, startLogin],
  );

  useEffect(
    () => () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    },
    [],
  );

  return (
    <div className="space-y-2 px-3 sm:px-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => begin("claude")}>
          Add Claude account
        </Button>
        <Button size="sm" variant="outline" onClick={() => begin("codex")}>
          Add Codex account
        </Button>
      </div>
      {status !== null ? (
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="mb-1 font-medium">
            {status.provider} login · {status.state}
          </div>
          {status.state === "awaiting-browser" && status.url !== null ? (
            <div className="space-y-1">
              <div className="text-secondary-label">
                Open this URL in your browser on this machine and finish the sign-in; the router
                picks the account up automatically:
              </div>
              <a
                className="break-all text-sky-600 underline underline-offset-2 dark:text-sky-300"
                href={status.url}
                target="_blank"
                rel="noreferrer"
              >
                {status.url}
              </a>
            </div>
          ) : null}
          {status.state === "done" ? (
            <div className="text-emerald-600 dark:text-emerald-300">
              Account added — it appears in the pool below.
            </div>
          ) : null}
          {status.state === "failed" ? (
            <div className="text-red-600 dark:text-red-300">{status.detail ?? "login failed"}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RouterPoolPanel() {
  const environmentId = useActiveEnvironmentId();
  const fetchAccounts = useAtomQueryRunner(routerPoolEnvironment.accounts, {
    reportFailure: false,
  });
  const toggleAccount = useAtomCommand(
    routerPoolEnvironment.toggleAccount,
    "router account toggle",
  );
  const [rows, setRows] = useState<readonly RouterAccountRow[] | null>(null);
  const nowMs = useRelativeTimeTick(30_000);

  const refresh = useCallback(
    (force = false) => {
      if (environmentId === null) return;
      void (async () => {
        const result = await fetchAccounts({ environmentId, input: { force } });
        if (result._tag === "Success") setRows(result.value.rows);
      })();
    },
    [environmentId, fetchAccounts],
  );

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const live = (rows ?? []).filter((row) => row.enabled).length;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Router Pool"
        headerAction={
          <div className="flex items-center gap-2 text-secondary-label text-xs">
            <span title="enabled / total router credentials">
              {rows === null ? "…" : `${live}/${rows.length}`}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh router accounts"
              onClick={() => refresh(true)}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        }
      >
        <div className="px-3 text-secondary-label text-xs sm:px-4">
          The CLIProxyAPI account pool every routed model runs on. Disabling an account removes it
          from routing immediately; meters are the providers' own 5h/weekly quotas.
        </div>
        <div className="space-y-2 px-3 sm:px-4">
          {rows === null ? (
            <div className="text-secondary-label text-sm">Loading router accounts…</div>
          ) : rows.length === 0 ? (
            <div className="text-secondary-label text-sm">router accounts unreachable</div>
          ) : (
            rows.map((row) => {
              const state = !row.enabled ? "disabled" : row.stale ? "stale" : (row.error ?? null);
              const last = row.enabled && live <= 1;
              return (
                <div key={row.file} className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={row.enabled}
                      disabled={last}
                      aria-label={`Enable ${row.email} (${row.provider})`}
                      onCheckedChange={() => {
                        void (async () => {
                          const result = await toggleAccount({
                            environmentId: environmentId as EnvironmentId,
                            input: { file: row.file, disabled: row.enabled },
                          });
                          if (result._tag === "Success") setRows(result.value.rows);
                        })();
                      }}
                    />
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-medium text-[10px] uppercase",
                        row.provider === "claude"
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-300/90"
                          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300/90",
                      )}
                    >
                      {row.provider}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 rounded-full",
                        state === null ? "bg-emerald-500" : "bg-red-500",
                      )}
                    />
                    <span className="font-medium text-sm" title={row.email}>
                      {maskEmail(row.email)}
                    </span>
                    {state !== null ? (
                      <span className="text-red-600 text-xs dark:text-red-300/90">{state}</span>
                    ) : null}
                  </div>
                  <div className="mt-2 space-y-1">
                    <QuotaRow label="5h" row={row} nowMs={nowMs} />
                    <QuotaRow label="week" row={row} nowMs={nowMs} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SettingsSection>
      {environmentId !== null ? (
        <SettingsSection title="Add Account">
          <div className="px-3 text-secondary-label text-xs sm:px-4">
            Runs the router's own login flow on the server. The new credential lands in the pool
            without a restart.
          </div>
          <LoginFlow environmentId={environmentId} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
