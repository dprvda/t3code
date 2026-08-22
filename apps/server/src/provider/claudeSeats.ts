/**
 * Rotation-seat listing for the accounts HOT/COOLING view: every claudeAgent
 * instance with an explicit continuation group (the rotation opt-in), its
 * official usage meters, and a derived state — ready (headroom), cooling (a
 * meter at cap, waiting for the window reset), unknown (meters unreachable
 * or credential stale). The meters are the same source the rotation reactor
 * confirms against; its in-memory text-triggered marks are deliberately not
 * surfaced — they only bridge the minutes when the meters are rate-limited.
 */
import type { ClaudeSeatRow, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { claudeSeatConfigDir } from "../orchestration/Layers/ClaudeSeatRotationReactor.ts";
import { meterBlocked } from "./claudeSeatGuard.ts";
import type { SeatLimitsFetcher } from "./claudeSeatLimits.ts";

function seatConfigBlob(settings: ServerSettings, instanceId: string): unknown {
  const explicit = settings.providerInstances[instanceId as ProviderInstanceId];
  if (explicit !== undefined) return explicit.config;
  return instanceId === "claudeAgent" ? settings.providers.claudeAgent : undefined;
}

function continuationGroupOf(settings: ServerSettings, instanceId: string): string | null {
  const config = seatConfigBlob(settings, instanceId);
  if (!Predicate.isObject(config)) return null;
  const group = (config as { continuationGroup?: unknown }).continuationGroup;
  if (!Predicate.isString(group)) return null;
  const trimmed = group.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function listClaudeSeats(
  settings: ServerSettings,
  fetcher: SeatLimitsFetcher,
  force: boolean,
): Promise<ClaudeSeatRow[]> {
  const candidateIds = new Set<string>(["claudeAgent"]);
  for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
    if (entry.driver === "claudeAgent") candidateIds.add(instanceId);
  }
  const rows: ClaudeSeatRow[] = [];
  for (const instanceId of candidateIds) {
    const group = continuationGroupOf(settings, instanceId);
    if (group === null) continue; // not a rotation seat
    const explicit = settings.providerInstances[instanceId as ProviderInstanceId];
    const limits = await fetcher.fetchSeatLimits(
      claudeSeatConfigDir(settings, instanceId as ProviderInstanceId),
      {
        force,
      },
    );
    const bars = limits === null || limits.stale ? [] : limits.bars;
    const blockedLabel = limits === null || limits.stale ? null : meterBlocked(limits.bars);
    rows.push({
      instanceId,
      displayName: explicit?.displayName ?? null,
      group,
      enabled: explicit?.enabled !== false,
      state:
        limits === null || limits.stale ? "unknown" : blockedLabel !== null ? "cooling" : "ready",
      blockedLabel,
      resetsAt:
        blockedLabel === null
          ? null
          : (bars.find((bar) => bar.label === blockedLabel)?.resetsAt ?? null),
      bars,
    });
  }
  return rows.toSorted(
    (left, right) =>
      left.group.localeCompare(right.group) || left.instanceId.localeCompare(right.instanceId),
  );
}
