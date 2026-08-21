import { describe, expect, it } from "@effect/vitest";

import { extractLimits, makeSeatLimitsFetcher } from "./claudeSeatLimits.ts";

describe("extractLimits", () => {
  it("shapes the oauth usage payload into labeled bars", () => {
    const bars = extractLimits({
      limits: [
        { kind: "session", percent: 62, resets_at: "2026-07-17T00:59:59Z" },
        { kind: "weekly_all", percent: 33, resets_at: "2026-07-18T06:59:59Z" },
        {
          kind: "weekly_scoped",
          percent: 51,
          resets_at: "2026-07-18T06:59:59Z",
          scope: { model: { display_name: "Fable" } },
        },
        { kind: "broken" }, // no percent: dropped
      ],
    });
    expect(bars.map((b) => `${b.label}:${b.pct}`)).toEqual(["5h:62", "week:33", "wk Fable:51"]);
  });
});

describe("makeSeatLimitsFetcher", () => {
  it("missing credentials file -> null, cached; force bypasses the cache", async () => {
    let calls = 0;
    const fetcher = makeSeatLimitsFetcher((() => {
      calls += 1;
      throw new Error("network must not be reached without credentials");
    }) as unknown as typeof fetch);
    const missing = "/nonexistent-claude-seat-dir";
    expect(await fetcher.fetchSeatLimits(missing)).toBeNull();
    expect(await fetcher.fetchSeatLimits(missing)).toBeNull(); // served from cache
    expect(await fetcher.fetchSeatLimits(missing, { force: true })).toBeNull();
    expect(calls).toBe(0); // read failure short-circuits before any fetch
  });
});
