/**
 * Pure scheduling core for the ScheduleReactor (ADE schedules port). A
 * schedule is due when it is enabled, today (local time) is one of its
 * weekdays, the clock is at or past hour:minute, and it has not fired today
 * yet — so a server that was down at the scheduled minute still fires when
 * it comes back the same day, and never twice.
 */
import type { ScheduledLaunch } from "@t3tools/contracts";

/** Local calendar day, the once-per-day dedupe key. */
export function localIsoDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function dueSchedules(
  schedules: ReadonlyArray<ScheduledLaunch>,
  now: Date,
  lastFiredDayById: ReadonlyMap<string, string>,
): ScheduledLaunch[] {
  const today = localIsoDay(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return schedules.filter((schedule) => {
    if (!schedule.enabled) return false;
    if (!schedule.days.includes(now.getDay())) return false;
    if (minutesNow < schedule.hour * 60 + schedule.minute) return false;
    return lastFiredDayById.get(schedule.id) !== today;
  });
}
