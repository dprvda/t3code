// @effect-diagnostics globalDate:off - pure policy core: callers inject `now`; the Date.now defaults keep call sites and tests simple.
/**
 * Claude seat gating and rotation policy: a seat is usable only when no limit
 * blocks it. Limits come from the official meters (5h session / weekly /
 * per-model weekly, see `claudeSeatLimits.ts`) plus a runtime hot-mark set when
 * a live session reports the limit AND a fresh meter fetch confirms it. Routing
 * is plain round-robin over usable seats; a fable-scoped weekly limit swaps the
 * launch to opus for that seat instead of skipping it.
 *
 * Everything here is a pure decision core over state held in the returned
 * guard instance — no I/O, no timers — so policy is testable in isolation. The
 * reactor that acts on these decisions lives beside the orchestration layers.
 *
 * Ported from ADE `src/main/lib/accounts-guard.ts` (2026-08-21).
 *
 * @module claudeSeatGuard
 */
import type { LimitBar } from "./claudeSeatLimits.ts";

export type ClaudeSeat = { name: string; configDir: string | null };

export const BLOCK_PCT = 100;

// model family ("fable" from "claude-fable-5") -> the downgrade when its scoped weekly cap is hit
const FAMILY_FALLBACK: Record<string, string> = { fable: "claude-opus-5" };

export function modelFamily(model: string): string {
  const m = /^claude-([a-z]+)/.exec(model);
  return m ? (m[1] as string) : model;
}

// seat-level block: the shared 5h session or weekly-all meter is exhausted
export function meterBlocked(bars: LimitBar[]): string | null {
  for (const b of bars) {
    if ((b.label === "5h" || b.label === "week") && b.pct >= BLOCK_PCT) return b.label;
  }
  return null;
}

// model-level block: a scoped weekly bar for this model family is exhausted
export function familyBlocked(bars: LimitBar[], model: string): boolean {
  const fam = modelFamily(model).toLowerCase();
  return bars.some(
    (b) => b.label.startsWith("wk ") && b.label.toLowerCase().includes(fam) && b.pct >= BLOCK_PCT,
  );
}

// which model family a limit message names, if any ("Fable 5 limit" -> fable);
// generic usage/5-hour messages return null (seat-level, not family)
export function bannerFamily(text: string): string | null {
  const m = /(fable|opus|sonnet|haiku)/i.exec(text);
  return m ? (m[1] as string).toLowerCase() : null;
}

export type RoutedPick = { seat: ClaudeSeat; model: string; swapped: boolean };

// hot-marks cap: a dead meter can never brick a seat past the 5h window
const HOT_CAP_MS = 5 * 60 * 60_000;
// family caps learned from limit messages outlive any 5h assumption (weekly windows)
const FAM_CAP_MS = 24 * 60 * 60_000;
// per-thread hop budget: acting on a limit signal alone (meters usually 429'd
// exactly when a big fleet is limited) risks a loop if conversation text echoes
// the phrase; two hops per hour per thread kills any such loop
const HOP_WINDOW_MS = 60 * 60_000;
const HOP_MAX = 2;

export interface ClaudeSeatGuard {
  markLimited(name: string, reason: string, now?: number): void;
  hotReason(name: string, now?: number): string | null;
  markFamilyLimited(name: string, family: string, now?: number): void;
  familyMarked(name: string, family: string, now?: number): boolean;
  clearIfRecovered(name: string, bars: LimitBar[]): void;
  allowHop(threadId: string, now?: number): boolean;
  pickUsable(
    seats: ClaudeSeat[],
    limitsFor: (seat: ClaudeSeat) => LimitBar[] | null,
    wantModel: string,
    allowFallback?: boolean,
    now?: number,
  ): RoutedPick | null;
}

export function makeClaudeSeatGuard(): ClaudeSeatGuard {
  // runtime hot-marks: set on a meter-confirmed limit signal; cleared when fresh meters recover
  const hot = new Map<string, { until: number; reason: string }>();
  // `${seat}|${family}` -> until. A family mark never blocks the seat; it feeds
  // the priority law (fallback-allowed work goes THERE on opus, fable-only work
  // avoids it).
  const famHot = new Map<string, number>();
  const hops = new Map<string, number[]>();
  let rr = 0;

  function markLimited(name: string, reason: string, now = Date.now()): void {
    hot.set(name, { until: now + HOT_CAP_MS, reason });
  }

  function hotReason(name: string, now = Date.now()): string | null {
    const h = hot.get(name);
    if (!h) return null;
    if (now > h.until) {
      hot.delete(name);
      return null;
    }
    return h.reason;
  }

  function markFamilyLimited(name: string, family: string, now = Date.now()): void {
    famHot.set(`${name}|${family}`, now + FAM_CAP_MS);
  }

  function familyMarked(name: string, family: string, now = Date.now()): boolean {
    const key = `${name}|${family}`;
    const until = famHot.get(key);
    if (!until) return false;
    if (now > until) {
      famHot.delete(key);
      return false;
    }
    return true;
  }

  // fresh meters showing headroom clear the marks (the window reset)
  function clearIfRecovered(name: string, bars: LimitBar[]): void {
    if (hot.has(name) && meterBlocked(bars) === null) hot.delete(name);
    for (const key of famHot.keys()) {
      if (!key.startsWith(`${name}|`)) continue;
      const fam = key.slice(name.length + 1);
      const scoped = bars.find(
        (b) => b.label.startsWith("wk ") && b.label.toLowerCase().includes(fam),
      );
      if (scoped && scoped.pct < BLOCK_PCT) famHot.delete(key);
    }
  }

  function allowHop(threadId: string, now = Date.now()): boolean {
    const ts = (hops.get(threadId) ?? []).filter((t) => now - t < HOP_WINDOW_MS);
    if (ts.length >= HOP_MAX) {
      hops.set(threadId, ts);
      return false;
    }
    ts.push(now);
    hops.set(threadId, ts);
    return true;
  }

  // Round-robin over USABLE seats. Prefers a seat where the wanted model family
  // is free; if every usable seat has the family capped, keeps the round-robin
  // pick and downgrades the model.
  function pickUsable(
    seats: ClaudeSeat[],
    limitsFor: (seat: ClaudeSeat) => LimitBar[] | null,
    wantModel: string,
    allowFallback = true, // false = family-strict, park instead of downgrading
    now = Date.now(),
  ): RoutedPick | null {
    const usable = seats.filter((s) => {
      if (hotReason(s.name, now)) return false;
      const bars = limitsFor(s);
      return bars === null || meterBlocked(bars) === null; // unreachable meters = not blocked
    });
    if (usable.length === 0) return null;
    const rotated = usable.map((_, i) => usable[(rr + i) % usable.length] as ClaudeSeat);
    rr += 1;
    const fam = modelFamily(wantModel);
    const fallback = FAMILY_FALLBACK[fam];
    // family capped = meters say so OR a limit message taught us so
    const capped = (s: ClaudeSeat): boolean => {
      if (familyMarked(s.name, fam, now)) return true;
      const bars = limitsFor(s);
      return bars !== null && familyBlocked(bars, wantModel);
    };
    // Priority law: work that ALLOWS the fallback should PREFER a seat whose
    // fable is capped (run there on opus) — its opus lane is otherwise idle,
    // and every fable-capable seat stays preserved for fable-only work.
    if (allowFallback && fallback) {
      const target = rotated.find(capped);
      if (target) return { seat: target, model: fallback, swapped: true };
    }
    for (const s of rotated) {
      if (!capped(s)) return { seat: s, model: wantModel, swapped: false };
    }
    // every usable seat has the wanted family capped
    if (!allowFallback) return null; // park until the family frees up
    return { seat: rotated[0] as ClaudeSeat, model: wantModel, swapped: false }; // no fallback rule for this family
  }

  return {
    markLimited,
    hotReason,
    markFamilyLimited,
    familyMarked,
    clearIfRecovered,
    allowHop,
    pickUsable,
  };
}

// ---- limit-message scanner ---------------------------------------------------------------
// Runtime output arrives in arbitrary chunks (possibly with ANSI); keep a small
// stripped rolling window per stream and match the limit banner. STRICT on
// purpose: "approaching" must not match, and the match alone never acts — the
// caller confirms against fresh meters first (replayed scrollback includes old
// banners; acting on text alone would cascade moves through every seat).
// Live-observed variants: "You've reached your Fable 5 limit. Run /usage-credits…",
// "You've hit your session limit · resets 8am", and the older "<window> limit reached".
const LIMIT_RE =
  /(?:(?:5-hour|weekly|session|usage)\s+limit reached|you['’]ve (?:reached|hit) your [^.\n·]{0,40}? limit)/i;
const WINDOW = 400;

export function stripAnsi(s: string): string {
  // CSI sequences, OSC sequences, and lone escapes
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "");
}

export interface LimitBannerScanner {
  scan(streamId: string, chunk: string): string | null;
  drop(streamId: string): void;
}

export function makeLimitBannerScanner(): LimitBannerScanner {
  const tails = new Map<string, string>();

  function scan(streamId: string, chunk: string): string | null {
    const text = (tails.get(streamId) ?? "") + stripAnsi(chunk).replace(/\s+/g, " ");
    const m = LIMIT_RE.exec(text);
    if (m) {
      tails.set(streamId, ""); // one-shot: a redrawn banner must not re-fire per chunk
      return m[0];
    }
    tails.set(streamId, text.slice(-WINDOW));
    return null;
  }

  function drop(streamId: string): void {
    tails.delete(streamId);
  }

  return { scan, drop };
}
