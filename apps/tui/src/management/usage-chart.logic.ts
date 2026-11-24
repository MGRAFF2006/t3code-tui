import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { isCompatibleUsageContractVersion } from "@t3tools/shared/usageMerge";
import { enumerateDays, enumerateHourStarts, formatHourShort } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type UsageChartMetric = "tokens" | "cost";
interface UsageChartValue {
  tokens: number;
  cost: number;
  records: number;
  unpriced: number;
}
export const USAGE_CHART_PAGE_SIZE = 8;
const MAX_DAYS = 4096;
const HOUR_MS = 3_600_000;

export function usageChartWindow(values: Record<string, string>): UsageSummaryInput {
  const timeZone = values.zone?.trim() ?? "";
  DateTime.zoneMakeNamedUnsafe(timeZone);
  const model = values.model?.trim();
  const provider = values.provider?.trim();
  if (provider && !model)
    throw new Error(
      "A provider filter requires a model ID. Chart providers can be hidden separately.",
    );
  const modelFilter = model
    ? { include: [{ model, ...(provider ? { provider } : {}) }] }
    : undefined;
  if (values.resolution === "hour") {
    const start = DateTime.make(values.sinceTime?.trim() ?? "");
    const end = DateTime.make(values.untilTime?.trim() ?? "");
    if (
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(values.sinceTime?.trim() ?? "") ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(values.untilTime?.trim() ?? "") ||
      Option.isNone(start) ||
      Option.isNone(end)
    )
      throw new Error("Hourly usage needs start and end instants with Z or a timezone offset.");
    const duration = DateTime.toEpochMillis(end.value) - DateTime.toEpochMillis(start.value);
    if (duration <= 0 || duration > 24 * HOUR_MS)
      throw new Error("Hourly usage must span more than zero and at most 24 hours.");
    return {
      sinceDay: UsageDay.make(
        DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(start.value, timeZone)),
      ),
      untilDay: UsageDay.make(
        DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(end.value, timeZone)),
      ),
      timeZone,
      resolution: "hour",
      sinceTime: DateTime.formatIso(start.value),
      untilTime: DateTime.formatIso(end.value),
      ...(modelFilter ? { modelFilter } : {}),
    };
  }
  const day = (value: string) => {
    const parsed = DateTime.make(`${value}T00:00:00Z`);
    if (Option.isNone(parsed) || DateTime.formatIsoDate(parsed.value) !== value)
      throw new Error("Choose valid calendar dates in YYYY-MM-DD format.");
    return UsageDay.make(value);
  };
  const sinceDay = day(values.since?.trim() ?? "");
  const untilDay = day(values.until?.trim() ?? "");
  if (sinceDay > untilDay) throw new Error("The first day must be before the last day.");
  return {
    sinceDay,
    untilDay,
    timeZone,
    resolution: "day",
    ...(modelFilter ? { modelFilter } : {}),
  };
}

export function usageChartData(summary: UsageSummary, window: UsageSummaryInput) {
  const hourly = window.resolution === "hour";
  let error: string | null = null;
  let periods: readonly string[] = [];
  if (!isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION))
    error = "The server usage format is incompatible. Use matching client and server versions.";
  else if (hourly) {
    if (!window.sinceTime || !window.untilTime)
      error = "Choose an hourly period with explicit start and end instants.";
    else periods = enumerateHourStarts(window.sinceTime, window.untilTime);
  } else {
    const days = (Date.parse(summary.untilDay) - Date.parse(summary.sinceDay)) / 86_400_000 + 1;
    if (!(days > 0) || days > MAX_DAYS)
      error = `Choose a chart period of at most ${MAX_DAYS.toLocaleString()} days. Usage details remain available below.`;
    else periods = enumerateDays(summary.sinceDay, summary.untilDay);
  }
  const byPeriod = new Map<string, Map<UsageProviderKind, UsageChartValue>>();
  const providers = new Set<UsageProviderKind>();
  const allowed = new Set(periods);
  for (const bucket of summary.buckets) {
    const period = hourly ? bucket.hourStart : bucket.day;
    if (!period || !allowed.has(period)) continue;
    providers.add(bucket.provider);
    let entries = byPeriod.get(period);
    if (!entries) {
      entries = new Map();
      byPeriod.set(period, entries);
    }
    const value = entries.get(bucket.provider) ?? { tokens: 0, cost: 0, records: 0, unpriced: 0 };
    value.tokens +=
      bucket.totals.uncachedInputTokens +
      bucket.totals.cachedInputTokens +
      bucket.totals.cacheCreationTokens +
      bucket.totals.outputTokens;
    value.cost += bucket.costUsd;
    value.records += bucket.records;
    value.unpriced += bucket.unpricedRecords;
    entries.set(bucket.provider, value);
  }
  return { periods, providers: [...providers].sort(), byPeriod, error, hourly };
}

export function usageChartValue(value: UsageChartValue | undefined, metric: UsageChartMetric) {
  if (!value) return 0;
  return metric === "tokens"
    ? value.tokens
    : value.records > 0 && value.unpriced >= value.records
      ? null
      : value.cost;
}

export function usageChartLabel(period: string, window: UsageSummaryInput) {
  if (window.resolution !== "hour") return period;
  const instant = DateTime.make(period);
  const day = Option.isSome(instant)
    ? DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(instant.value, window.timeZone))
    : period;
  return `${day} ${formatHourShort(period, window.timeZone, false)}`;
}
