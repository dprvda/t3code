// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads seat credential files at the Node boundary; `now` and `fetch` are injectable for tests.
/**
 * Claude seat usage meters: the same limits Claude Code's /usage screen shows,
 * fetched per seat from the OAuth usage endpoint with that seat's stored access
 * token. This is the provider's own utilization (session 5h + weekly all +
 * per-model weekly), not an estimate.
 *
 * Tokens are read read-only from the seat config dir's `.credentials.json`; an
 * expired token yields `{ stale: true }` (any live session on that seat
 * refreshes the file; we never mint or refresh tokens ourselves).
 *
 * `extractLimits` is pure so the bar shaping is testable without the network.
 *
 * Ported from ADE `src/main/lib/accounts-limits.ts` (2026-08-21).
 *
 * @module claudeSeatLimits
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

export type LimitBar = { pct: number; resetsAt: string | null; label: string };
export type SeatLimits = { stale: boolean; bars: LimitBar[] };

// exported for tests: shape the endpoint payload into labeled bars
export function extractLimits(payload: {
  limits?: {
    kind?: string;
    percent?: number;
    resets_at?: string;
    scope?: { model?: { display_name?: string } } | null;
  }[];
}): LimitBar[] {
  const bars: LimitBar[] = [];
  for (const l of payload.limits ?? []) {
    if (typeof l.percent !== "number") continue;
    const label =
      l.kind === "session"
        ? "5h"
        : l.kind === "weekly_all"
          ? "week"
          : l.kind === "weekly_scoped"
            ? `wk ${l.scope?.model?.display_name ?? "model"}`
            : (l.kind ?? "limit");
    bars.push({ pct: l.percent, resetsAt: l.resets_at ?? null, label });
  }
  return bars;
}

function credFile(configDir: string | null, home: string): string {
  return NodePath.join(configDir ?? NodePath.join(home, ".claude"), ".credentials.json");
}

// 180s success TTL: the endpoint rate-limits per IP and a busy fleet's own
// statusline polling already eats most of the budget. A failed fetch (429 or
// offline) backs off harder — retrying every TTL keeps the caller rate-limited
// and the meters "unreachable" for everyone.
const TTL_MS = 180_000;
const FAIL_TTL_MS = 300_000;

export interface SeatLimitsFetcher {
  fetchSeatLimits(
    configDir: string | null,
    options?: { force?: boolean; home?: string },
  ): Promise<SeatLimits | null>;
}

export function makeSeatLimitsFetcher(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): SeatLimitsFetcher {
  const cache = new Map<string, { at: number; ttl: number; limits: SeatLimits | null }>();

  async function fetchSeatLimits(
    configDir: string | null,
    options?: { force?: boolean; home?: string },
  ): Promise<SeatLimits | null> {
    const home = options?.home ?? NodeOS.homedir();
    const key = configDir ?? "default";
    const hit = cache.get(key);
    // force bypasses the cache: used to CONFIRM a runtime limit signal before acting
    if (!options?.force && hit && now() - hit.at < hit.ttl) return hit.limits;

    let limits: SeatLimits | null = null;
    let failed = false;
    try {
      const cred = JSON.parse(NodeFS.readFileSync(credFile(configDir, home), "utf8")) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      };
      const tok = cred.claudeAiOauth?.accessToken;
      const exp = cred.claudeAiOauth?.expiresAt ?? 0;
      if (!tok) limits = null;
      else if (exp && exp < now()) limits = { stale: true, bars: [] };
      else {
        const res = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
          headers: { Authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok)
          limits = {
            stale: false,
            bars: extractLimits((await res.json()) as Parameters<typeof extractLimits>[0]),
          };
        else if (res.status === 401) limits = { stale: true, bars: [] };
        else failed = true; // 429/5xx: back off, don't keep ourselves rate-limited
      }
    } catch {
      failed = true; // offline or racing a login
    }
    cache.set(key, { at: now(), ttl: failed ? FAIL_TTL_MS : TTL_MS, limits });
    return limits;
  }

  return { fetchSeatLimits };
}
