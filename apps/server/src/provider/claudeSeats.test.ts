import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import { listClaudeSeats } from "./claudeSeats.ts";
import type { SeatLimits } from "./claudeSeatLimits.ts";

function settingsWithSeats(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      claude_acct1: {
        driver: "claudeAgent",
        displayName: "Max seat 1",
        config: { homePath: "~/.claude-acct1", continuationGroup: "max-pool" },
      },
      claude_acct2: {
        driver: "claudeAgent",
        config: { homePath: "~/.claude-acct2", continuationGroup: "max-pool" },
      },
      claudeAgent_codex_router: {
        driver: "claudeAgent",
        config: { homePath: "~/.claude-router-codex" }, // no group: not a seat
      },
    },
  } as ServerSettings;
}

describe("listClaudeSeats", () => {
  it("lists only continuation-group seats with derived ready/cooling/unknown states", async () => {
    const limitsByDir = new Map<string, SeatLimits | null>([
      // acct1: weekly meter capped -> cooling
      [
        "acct1",
        {
          stale: false,
          bars: [
            { label: "5h", pct: 40, resetsAt: "2026-08-22T20:00:00Z" },
            { label: "week", pct: 100, resetsAt: "2026-08-25T00:00:00Z" },
          ],
        },
      ],
      // acct2: unreachable -> unknown
      ["acct2", null],
    ]);
    const seats = await listClaudeSeats(
      settingsWithSeats(),
      {
        fetchSeatLimits: (configDir) =>
          Promise.resolve(
            limitsByDir.get(configDir?.includes("acct1") ? "acct1" : "acct2") ?? null,
          ),
      },
      false,
    );
    expect(seats.map((seat) => seat.instanceId)).toEqual(["claude_acct1", "claude_acct2"]);
    const [first, second] = seats;
    expect(first).toMatchObject({
      displayName: "Max seat 1",
      group: "max-pool",
      state: "cooling",
      blockedLabel: "week",
      resetsAt: "2026-08-25T00:00:00Z",
    });
    expect(second).toMatchObject({ displayName: null, state: "unknown", blockedLabel: null });
  });

  it("no rotation groups configured yields no rows", async () => {
    const seats = await listClaudeSeats(
      DEFAULT_SERVER_SETTINGS,
      { fetchSeatLimits: () => Promise.resolve(null) },
      false,
    );
    expect(seats).toEqual([]);
  });
});
