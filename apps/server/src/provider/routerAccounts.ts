// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads the router's auth files and spawns its login CLI at the Node boundary; time/fetch injectable in tests via the exported pure helpers.
/**
 * CLIProxyAPI router pool: enumerate the router's OAuth accounts from its
 * auth directory, show their official 5h/weekly quota meters, toggle
 * membership, and run new provider logins through the router's own CLI.
 *
 * Membership truth is the auth dir (`~/.cli-proxy-api/auth/*.json`): one JSON
 * per account, named `claude-<email>.json` / `codex-<email>[-pro].json`.
 * Disabling writes `"disabled": true` INTO the file — the router's fsnotify
 * watcher hot-applies it, no restart, no management API. Meters are fetched
 * with each file's own access token against the provider's official usage
 * endpoint; tokens never leave this module.
 *
 * Ported from ADE `src/main/lib/router-accounts.ts` (2026-08-21), plus the
 * login runner ADE never had (`cli-proxy-api -claude-login|-codex-login`,
 * spawned with `-no-browser`; the printed OAuth URL is surfaced to the user
 * and the CLI's local callback server completes the exchange and writes the
 * auth file, which the running router hot-loads).
 *
 * @module routerAccounts
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type RouterQuotaWindow = {
  readonly label: "5h" | "week";
  readonly pct: number;
  readonly resetsAt: string | null;
};

export type RouterAccountRow = {
  /** auth file name — the row key; emails are NOT unique across providers */
  readonly file: string;
  readonly provider: "claude" | "codex";
  readonly email: string;
  readonly enabled: boolean;
  readonly stale: boolean;
  readonly error: string | null;
  readonly windows: readonly RouterQuotaWindow[];
};

const AUTH_FILE_RE = /^(claude|codex)-[^/\\]+\.json$/i;

export function routerAuthDir(home: string = NodeOS.homedir()): string {
  return NodePath.join(home, ".cli-proxy-api", "auth");
}

function pct(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Claude payload: top-level five_hour / seven_day {utilization, resets_at}
export function claudeWindows(payload: {
  five_hour?: { utilization?: number; resets_at?: string | null };
  seven_day?: { utilization?: number; resets_at?: string | null };
}): RouterQuotaWindow[] {
  const out: RouterQuotaWindow[] = [];
  if (payload.five_hour) {
    out.push({
      label: "5h",
      pct: pct(payload.five_hour.utilization),
      resetsAt: payload.five_hour.resets_at ?? null,
    });
  }
  if (payload.seven_day) {
    out.push({
      label: "week",
      pct: pct(payload.seven_day.utilization),
      resetsAt: payload.seven_day.resets_at ?? null,
    });
  }
  return out;
}

// Codex payload: rate_limit.primary_window / secondary_window with
// used_percent + limit_window_seconds + reset_at (epoch seconds). Label is
// chosen by duration; typically only the weekly window exists.
export function codexWindows(payload: {
  rate_limit?: {
    primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
  };
}): RouterQuotaWindow[] {
  const out: RouterQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const w of [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window]) {
    if (!w || typeof w.used_percent !== "number") continue;
    const label = (w.limit_window_seconds ?? 0) <= 6 * 3600 ? "5h" : "week";
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({
      label,
      pct: pct(w.used_percent),
      resetsAt: typeof w.reset_at === "number" ? new Date(w.reset_at * 1000).toISOString() : null,
    });
  }
  return out.sort((a, b) => (a.label === b.label ? 0 : a.label === "5h" ? -1 : 1));
}

type StoredAuth = {
  type?: string;
  email?: string;
  access_token?: string;
  account_id?: string;
  disabled?: boolean;
  expired?: string;
};

const CACHE_TTL_MS = 180_000;

export interface RouterAccountsService {
  list(force?: boolean): Promise<RouterAccountRow[]>;
  setDisabled(file: string, disabled: boolean): void;
}

export function makeRouterAccounts(
  home: string = NodeOS.homedir(),
  fetchFn: typeof fetch = fetch,
): RouterAccountsService {
  let cache: { at: number; rows: RouterAccountRow[] } | null = null;

  async function list(force = false): Promise<RouterAccountRow[]> {
    if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
    const dir = routerAuthDir(home);
    let files: string[];
    try {
      files = NodeFS.readdirSync(dir)
        .filter((name) => AUTH_FILE_RE.test(name))
        .sort((a, b) =>
          a.startsWith("claude-") === b.startsWith("claude-")
            ? a.localeCompare(b)
            : a.startsWith("claude-")
              ? -1
              : 1,
        );
    } catch {
      return [];
    }
    const rows: RouterAccountRow[] = [];
    for (const file of files) {
      let auth: StoredAuth;
      try {
        auth = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, file), "utf8")) as StoredAuth;
      } catch {
        rows.push({
          file,
          provider: file.startsWith("codex-") ? "codex" : "claude",
          email: file,
          enabled: false,
          stale: false,
          error: "unreadable",
          windows: [],
        });
        continue;
      }
      const provider = auth.type === "codex" || file.startsWith("codex-") ? "codex" : "claude";
      const stale = Boolean(auth.expired && Date.parse(auth.expired) <= Date.now());
      const email =
        auth.email ?? file.replace(/^(claude|codex)-/, "").replace(/(?:-pro)?\.json$/i, "");
      const enabled = auth.disabled !== true;
      let error: string | null = null;
      let windows: RouterQuotaWindow[] = [];
      if (enabled && !stale && auth.access_token) {
        try {
          const url =
            provider === "claude"
              ? "https://api.anthropic.com/api/oauth/usage"
              : "https://chatgpt.com/backend-api/wham/usage";
          const headers: Record<string, string> = {
            Authorization: `Bearer ${auth.access_token}`,
            "user-agent": provider === "claude" ? "claude-cli" : "codex-cli",
          };
          if (provider === "claude") {
            headers["anthropic-beta"] = "oauth-2025-04-20";
            headers["anthropic-version"] = "2023-06-01";
          } else if (auth.account_id) {
            headers["ChatGPT-Account-Id"] = auth.account_id;
          }
          const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
          if (res.ok) {
            const payload = (await res.json()) as never;
            windows = provider === "claude" ? claudeWindows(payload) : codexWindows(payload);
          } else if (res.status === 401) {
            error = "stale token";
          } else if (res.status === 403) {
            error = "not entitled";
          } else {
            error = "unreachable";
          }
        } catch {
          error = "unreachable";
        }
      }
      rows.push({ file, provider, email, enabled, stale, error, windows });
    }
    cache = { at: Date.now(), rows };
    return rows;
  }

  function setDisabled(file: string, disabled: boolean): void {
    if (!AUTH_FILE_RE.test(file)) throw new Error(`bad auth file: ${file}`);
    const target = NodePath.join(routerAuthDir(home), file);
    // read-modify-write keeps access_token/refresh_token/expired intact; the
    // router's fsnotify watcher hot-applies the flag
    const auth = JSON.parse(NodeFS.readFileSync(target, "utf8")) as Record<string, unknown>;
    auth["disabled"] = disabled;
    NodeFS.writeFileSync(target, JSON.stringify(auth));
    cache = null;
  }

  return { list, setDisabled };
}

// ---- login runner ------------------------------------------------------------------------

export type RouterLoginProvider = "claude" | "codex";
export type RouterLoginState = "starting" | "awaiting-browser" | "done" | "failed";

export type RouterLoginStatus = {
  readonly loginId: string;
  readonly provider: RouterLoginProvider;
  readonly state: RouterLoginState;
  readonly url: string | null;
  readonly detail: string | null;
};

type LoginJob = {
  status: RouterLoginStatus;
  proc: ChildProcess;
};

const LOGIN_FLAG: Record<RouterLoginProvider, string> = {
  claude: "-claude-login",
  codex: "-codex-login",
};

export interface RouterLoginRunner {
  start(provider: RouterLoginProvider): RouterLoginStatus;
  status(loginId: string): RouterLoginStatus | null;
  cancel(loginId: string): void;
}

export function makeRouterLoginRunner(
  home: string = NodeOS.homedir(),
  binaryPath = NodePath.join(home, "work", "CLIProxyAPI", "bin", "cli-proxy-api"),
): RouterLoginRunner {
  const jobs = new Map<string, LoginJob>();
  let nextId = 1;

  function start(provider: RouterLoginProvider): RouterLoginStatus {
    const loginId = `login-${nextId++}`;
    const configPath = NodePath.join(home, ".cli-proxy-api", "config.yaml");
    const proc = spawn(binaryPath, [LOGIN_FLAG[provider], "-no-browser", "-config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job: LoginJob = {
      status: { loginId, provider, state: "starting", url: null, detail: null },
      proc,
    };
    jobs.set(loginId, job);
    let buffer = "";
    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (job.status.url === null) {
        const m = /https:\/\/\S+/.exec(buffer);
        if (m) {
          job.status = { ...job.status, state: "awaiting-browser", url: m[0] };
        }
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (error) => {
      job.status = { ...job.status, state: "failed", detail: error.message };
    });
    proc.on("exit", (code) => {
      job.status =
        code === 0
          ? { ...job.status, state: "done" }
          : {
              ...job.status,
              state: "failed",
              detail: job.status.detail ?? `login process exited with code ${code}`,
            };
    });
    return job.status;
  }

  function status(loginId: string): RouterLoginStatus | null {
    return jobs.get(loginId)?.status ?? null;
  }

  function cancel(loginId: string): void {
    const job = jobs.get(loginId);
    if (job && job.status.state !== "done" && job.status.state !== "failed") {
      job.proc.kill();
      job.status = { ...job.status, state: "failed", detail: "cancelled" };
    }
  }

  return { start, status, cancel };
}
