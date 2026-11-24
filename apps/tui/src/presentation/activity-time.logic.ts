import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";

export interface ActivityTiming {
  readonly startedAt: number;
  readonly completedAt: number | null;
}

export function activityDuration(timing: ActivityTiming, now: number) {
  const elapsed = Math.max(0, (timing.completedAt ?? now) - timing.startedAt);
  if (timing.completedAt === null && elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`;
  return formatDuration(elapsed);
}

export function resetCountdown(resetAt: string | null | undefined, now: number) {
  if (!resetAt) return null;
  const deadline = Date.parse(resetAt);
  if (!Number.isFinite(deadline)) return null;
  const remaining = Math.ceil((deadline - now) / 1_000) * 1_000;
  return remaining > 0 ? `Reset in ${formatDuration(remaining)}` : "Reset time reached";
}
