import { describe, expect, it } from "@effect/vitest";

import {
  bannerFamily,
  familyBlocked,
  makeClaudeSeatGuard,
  makeLimitBannerScanner,
  meterBlocked,
  modelFamily,
  stripAnsi,
  type ClaudeSeat,
} from "./claudeSeatGuard.ts";
import type { LimitBar } from "./claudeSeatLimits.ts";

const bar = (label: string, pct: number): LimitBar => ({ label, pct, resetsAt: null });
const pool: ClaudeSeat[] = [
  { name: "acct1", configDir: null },
  { name: "acct2", configDir: "b" },
  { name: "acct3", configDir: "c" },
];

describe("meterBlocked / familyBlocked", () => {
  it("blocks on exhausted 5h or weekly, not on high-but-alive or scoped bars", () => {
    expect(meterBlocked([bar("5h", 100)])).toBe("5h");
    expect(meterBlocked([bar("week", 100)])).toBe("week");
    expect(meterBlocked([bar("5h", 99), bar("week", 97)])).toBeNull();
    expect(meterBlocked([bar("wk Fable", 100)])).toBeNull(); // scoped caps never block the seat
  });
  it("familyBlocked matches the scoped weekly bar for the model family only", () => {
    const bars = [bar("5h", 10), bar("wk Fable", 100), bar("wk Opus", 20)];
    expect(familyBlocked(bars, "claude-fable-5")).toBe(true);
    expect(familyBlocked(bars, "claude-opus-5")).toBe(false);
    expect(modelFamily("claude-fable-5")).toBe("fable");
  });
});

describe("pickUsable", () => {
  it("usable = not hot-marked and not meter-blocked", () => {
    const guard = makeClaudeSeatGuard();
    const limits: Record<string, LimitBar[]> = {
      acct1: [bar("5h", 100)],
      acct2: [bar("5h", 10)],
      acct3: [bar("5h", 10)],
    };
    const names = [1, 2, 3, 4].map(
      () => guard.pickUsable(pool, (s) => limits[s.name] ?? null, "claude-sonnet-5")!.seat.name,
    );
    expect(names).not.toContain("acct1");
    expect(new Set(names)).toEqual(new Set(["acct2", "acct3"])); // round-robin over the usable two
  });
  it("hot-marked seat is excluded until recovery clears it", () => {
    const guard = makeClaudeSeatGuard();
    guard.markLimited("acct2", "5h limit");
    const picks = [1, 2, 3].map(
      () => guard.pickUsable(pool, () => null, "claude-sonnet-5")!.seat.name,
    );
    expect(picks).not.toContain("acct2");
    guard.clearIfRecovered("acct2", [bar("5h", 3)]);
    expect(guard.hotReason("acct2")).toBeNull();
  });
  it("all seats limited -> null (caller refuses the spawn)", () => {
    const guard = makeClaudeSeatGuard();
    const blocked = [bar("week", 100)];
    expect(guard.pickUsable(pool, () => blocked, "claude-sonnet-5")).toBeNull();
  });
  it("fable capped on every usable seat -> opus downgrade (fallback allowed)", () => {
    const guard = makeClaudeSeatGuard();
    const bars = [bar("5h", 10), bar("wk Fable", 100)];
    const p = guard.pickUsable(pool, () => bars, "claude-fable-5")!;
    expect(p.model).toBe("claude-opus-5");
    expect(p.swapped).toBe(true);
  });
  it("fallback OFF: fable capped everywhere -> null (park); with headroom -> that seat", () => {
    const guard = makeClaudeSeatGuard();
    const bars = [bar("5h", 10), bar("wk Fable", 100)];
    expect(guard.pickUsable(pool, () => bars, "claude-fable-5", false)).toBeNull();
    const mixed: Record<string, LimitBar[]> = {
      acct1: [bar("wk Fable", 100)],
      acct2: [bar("wk Fable", 5)],
      acct3: [bar("wk Fable", 100)],
    };
    const p = guard.pickUsable(pool, (s) => mixed[s.name] ?? null, "claude-fable-5", false)!;
    expect(p.seat.name).toBe("acct2");
    expect(p.model).toBe("claude-fable-5");
  });
  it("priority law: fallback-allowed work PREFERS a fable-capped seat on opus, preserving fable seats", () => {
    const guard = makeClaudeSeatGuard();
    const limits: Record<string, LimitBar[]> = {
      acct1: [bar("wk Fable", 100)],
      acct2: [bar("wk Fable", 5)],
      acct3: [bar("wk Fable", 100)],
    };
    for (let i = 0; i < 4; i++) {
      const p = guard.pickUsable(pool, (s) => limits[s.name] ?? null, "claude-fable-5")!;
      expect(["acct1", "acct3"]).toContain(p.seat.name); // never burns acct2's fable
      expect(p.model).toBe("claude-opus-5");
      expect(p.swapped).toBe(true);
    }
  });
  it("non-fable launches ignore the priority law (no fallback rule for sonnet/opus)", () => {
    const guard = makeClaudeSeatGuard();
    const limits: Record<string, LimitBar[]> = {
      acct1: [bar("wk Fable", 100)],
      acct2: [bar("wk Fable", 5)],
      acct3: [bar("wk Fable", 100)],
    };
    const p = guard.pickUsable(pool, (s) => limits[s.name] ?? null, "claude-sonnet-5")!;
    expect(p.model).toBe("claude-sonnet-5");
    expect(p.swapped).toBe(false);
  });
});

describe("allowHop", () => {
  it("allows two moves per thread per hour, then refuses (echo-loop kill switch)", () => {
    const guard = makeClaudeSeatGuard();
    const t0 = 1_000_000;
    expect(guard.allowHop("thread-a", t0)).toBe(true);
    expect(guard.allowHop("thread-a", t0 + 1000)).toBe(true);
    expect(guard.allowHop("thread-a", t0 + 2000)).toBe(false);
    expect(guard.allowHop("thread-b", t0 + 2000)).toBe(true); // budgets are per thread
    expect(guard.allowHop("thread-a", t0 + 61 * 60_000)).toBe(true); // window slid
  });
});

describe("limit banner scanner", () => {
  it("matches the banner across chunk boundaries, through ANSI, one-shot", () => {
    const scanner = makeLimitBannerScanner();
    expect(scanner.scan("p1", "\x1b[33m5-hour limit")).toBeNull();
    expect(scanner.scan("p1", " reached \x1b[0m∙ resets 3am")).toBeTruthy();
    // one-shot: the same tail must not re-fire on the next unrelated chunk
    expect(scanner.scan("p1", " more output")).toBeNull();
  });
  it('never matches "approaching usage limit"', () => {
    const scanner = makeLimitBannerScanner();
    expect(scanner.scan("p2", "approaching usage limit ∙ resets 6pm")).toBeNull();
  });
  it("matches the live banner variants and the match names the family for bannerFamily", () => {
    const scanner = makeLimitBannerScanner();
    const hit = scanner.scan(
      "p3",
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    );
    expect(hit).toBeTruthy();
    expect(bannerFamily(hit!)).toBe("fable");
    const generic = scanner.scan("p4", "You’ve reached your usage limit.");
    expect(generic).toBeTruthy();
    expect(bannerFamily(generic!)).toBeNull();
    // "hit" variant with middle-dot suffix
    const hitVariant = scanner.scan(
      "p5",
      "You’ve hit your session limit · resets 8am (Europe/Kiev)",
    );
    expect(hitVariant).toBeTruthy();
    expect(bannerFamily(hitVariant!)).toBeNull(); // session = seat-level, not a family cap
  });
  it("family marks steer routing without meters: capped seat preferred on opus, avoided by strict work", () => {
    const guard = makeClaudeSeatGuard();
    guard.markFamilyLimited("acct2", "fable");
    const allowed = guard.pickUsable(pool, () => null, "claude-fable-5", true)!;
    expect(allowed.seat.name).toBe("acct2"); // priority law from the banner-taught mark
    expect(allowed.model).toBe("claude-opus-5");
    const strict = guard.pickUsable(pool, () => null, "claude-fable-5", false)!;
    expect(strict.seat.name).not.toBe("acct2"); // strict work avoids the marked seat
    expect(strict.model).toBe("claude-fable-5");
    guard.clearIfRecovered("acct2", [{ label: "wk Fable 5", pct: 12, resetsAt: null }]);
    expect(guard.pickUsable(pool, () => null, "claude-fable-5", true)!.swapped).toBe(false); // mark cleared
  });
  it("stripAnsi removes CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07plain \x1b[1;32mgreen\x1b[0m")).toBe("plain green");
  });
});
