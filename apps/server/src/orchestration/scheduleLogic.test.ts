// @effect-diagnostics globalDate:off - the schedule policy is local-wall-clock by design; tests build local Dates.
import { describe, expect, it } from "@effect/vitest";
import type { ScheduledLaunch } from "@t3tools/contracts";

import { dueSchedules, localIsoDay } from "./scheduleLogic.ts";

function schedule(overrides: Partial<ScheduledLaunch> = {}): ScheduledLaunch {
  return {
    id: "sched-1",
    name: "",
    projectTitle: "app-assay",
    prompt: "run the morning sweep",
    days: [1, 2, 3, 4, 5],
    hour: 9,
    minute: 0,
    enabled: true,
    ...overrides,
  } as ScheduledLaunch;
}

// 2026-08-24 is a Monday (day 1).
const MONDAY_0930 = new Date(2026, 7, 24, 9, 30);

describe("dueSchedules", () => {
  it("fires at/past the scheduled minute on a scheduled day, once per day", () => {
    expect(dueSchedules([schedule()], MONDAY_0930, new Map())).toHaveLength(1);
    // already fired today
    expect(
      dueSchedules([schedule()], MONDAY_0930, new Map([["sched-1", "2026-08-24"]])),
    ).toHaveLength(0);
    // fired yesterday: due again
    expect(
      dueSchedules([schedule()], MONDAY_0930, new Map([["sched-1", "2026-08-23"]])),
    ).toHaveLength(1);
  });

  it("not due before the minute, on other days, or when disabled", () => {
    const monday0859 = new Date(2026, 7, 24, 8, 59);
    expect(dueSchedules([schedule()], monday0859, new Map())).toHaveLength(0);
    const sunday = new Date(2026, 7, 23, 9, 30);
    expect(dueSchedules([schedule()], sunday, new Map())).toHaveLength(0);
    expect(dueSchedules([schedule({ enabled: false })], MONDAY_0930, new Map())).toHaveLength(0);
  });

  it("localIsoDay pads and uses local time", () => {
    expect(localIsoDay(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});
